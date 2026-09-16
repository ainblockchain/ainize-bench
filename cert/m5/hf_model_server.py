#!/usr/bin/env python3
"""지표 5 — Hugging Face transformers 를 OpenAI 호환 런타임으로 노출한다.

Ainize 노드의 `runtime.api` 가 가리키는 서버다. 한 번에 모델 하나만 싣고,
`/v1/models` 는 실제로 실린 저장소 ID 를 그대로 보고한다. 요청한 모델이
실린 모델과 다르면 404 로 거절한다. 다른 모델의 답으로 대체하지 않는다.

  POST /admin/load  {"model_id": "owner/name"}   모델 교체 (이전 모델 자원 해제)
  GET  /admin/state                              실린 모델·revision·자원
  GET  /v1/models                                OpenAI 호환 목록
  POST /v1/chat/completions | /v1/completions    추론
"""
import json, os, threading, time, traceback, gc
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, AutoConfig

PORT = int(os.environ.get('M5_PORT', '8410'))
DEVICE = os.environ.get('M5_DEVICE', 'cuda:0')
MAX_NEW = int(os.environ.get('M5_MAX_NEW_TOKENS', '48'))

LOCK = threading.Lock()
STATE = {'model_id': None, 'revision': None, 'loaded_at': None, 'dtype': None,
         'architectures': None, 'device': DEVICE, 'params': None}
MODEL = {'m': None, 'tok': None}


def unload():
    MODEL['m'] = None
    MODEL['tok'] = None
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    for k in ('model_id', 'revision', 'loaded_at', 'dtype', 'architectures', 'params'):
        STATE[k] = None


def load(model_id):
    unload()
    cfg = AutoConfig.from_pretrained(model_id, trust_remote_code=True)
    tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    m = AutoModelForCausalLM.from_pretrained(model_id, dtype=dtype, trust_remote_code=True)
    m.to(DEVICE)
    m.eval()
    if tok.pad_token_id is None and tok.eos_token_id is not None:
        tok.pad_token = tok.eos_token
    MODEL['m'], MODEL['tok'] = m, tok
    STATE.update({
        'model_id': model_id,
        'revision': getattr(m.config, '_commit_hash', None) or getattr(cfg, '_commit_hash', None),
        'loaded_at': int(time.time() * 1000),
        'dtype': str(dtype).replace('torch.', ''),
        'architectures': getattr(cfg, 'architectures', None),
        'params': int(sum(p.numel() for p in m.parameters())),
    })
    return STATE


def generate(prompt, max_new_tokens, stop=()):
    """한 번 생성하고, 정지 문자열이 있으면 거기서 자른다.

    정지 문자열은 OpenAI API 의 `stop` 과 같은 뜻이다. 이어쓰기 모델에 few-shot 형식을
    주면 답 뒤에 다음 문답을 계속 지어내므로, 그 경계에서 끊는다. 자르기 전 원문도
    함께 돌려주어 증빙에 남긴다.
    """
    tok, m = MODEL['tok'], MODEL['m']
    enc = tok(prompt, return_tensors='pt').to(DEVICE)
    with torch.no_grad():
        out = m.generate(**enc, max_new_tokens=max_new_tokens, do_sample=False,
                         pad_token_id=tok.pad_token_id or tok.eos_token_id)
    gen = out[0][enc['input_ids'].shape[-1]:]
    raw = tok.decode(gen, skip_special_tokens=True)
    text = raw
    for s in stop:
        i = text.find(s)
        if i >= 0:
            text = text[:i]
    return text.strip(), raw, int(enc['input_ids'].shape[-1]), int(gen.shape[-1])


def turn_stops(tok):
    """이 모델의 채팅 템플릿이 새 발화 앞에 넣는 표시를 찾아 정지 문자열로 쓴다.

    지시 학습이 되지 않은 기반 모델은 템플릿이 있어도 끝 토큰을 내지 않고 상대의
    다음 발화까지 계속 지어낸다. 그 결과를 그대로 답으로 쓰면 한 질문에 대화 전체가
    돌아온다. 템플릿에 실제 문자열을 넣어 렌더링해 보고, 답 뒤에 오는 경계를 읽어낸다.
    모델마다 다르므로 추측하지 않고 그 모델의 템플릿에서 얻는다.
    """
    marks = []
    for t in (getattr(tok, 'eos_token', None), '<|im_end|>', '<|eot_id|>', '<|end|>'):
        if t:
            marks.append(t)
    try:
        rendered = tok.apply_chat_template(
            [{'role': 'user', 'content': 'AAA'}, {'role': 'assistant', 'content': 'BBB'},
             {'role': 'user', 'content': 'CCC'}], tokenize=False)
        i, j = rendered.find('BBB'), rendered.find('CCC')
        if 0 <= i < j:
            between = rendered[i + 3:j]
            if between.strip():
                marks.append(between)
                # 렌더링된 경계에서 공백만 다듬은 형태도 함께 받는다 (특수 토큰이 없는 모델)
                marks.append(between.strip())
    except Exception:
        pass
    return tuple(dict.fromkeys(m for m in marks if m))


def to_prompt(messages, template_kwargs=None):
    """대화를 이 모델이 실제로 읽는 형식으로 바꾼다.

    채팅 템플릿이 있는 모델은 그 템플릿을 쓴다. 템플릿이 없는 모델은 대화형이 아니라
    이어쓰기 모델이므로, 채팅 형식을 주면 바로 끝 토큰을 내고 빈 답이 된다. 그런
    모델에는 이어쓰기 형식을 준다. 모델을 바꾸는 것이 아니라 같은 질문을 그 모델이
    읽을 수 있는 형태로 주는 것이다.
    """
    tok = MODEL['tok']
    if getattr(tok, 'chat_template', None):
        try:
            # 템플릿이 받는 추가 인자를 그대로 넘긴다. Qwen3 계열은 `enable_thinking` 으로
            # 추론 구간을 켜고 끄는데, 이것을 무시하면 짧은 답 예산이 <think> 로 다 차서
            # 답이 비어 돌아온다. 모델이 아니라 요청 형식의 문제다.
            return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,
                                           **(template_kwargs or {})), turn_stops(tok)
        except Exception:
            # 추가 인자를 받지 않는 템플릿이 있다. 템플릿 자체는 쓸 수 있으므로 인자만 빼고 다시 한다.
            if template_kwargs:
                try:
                    return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True), turn_stops(tok)
                except Exception:
                    pass
    turns = []
    for msg in messages:
        role, content = msg.get('role', 'user'), (msg.get('content') or '').strip()
        if not content:
            continue
        turns.append(('Q: ' + content) if role != 'assistant' else ('A: ' + content))
    # 이어쓰기 모델은 답 뒤에 다음 문답을 그대로 이어 쓴다. 우리가 준 형식의 표시를
    # 정지 문자열로 준다: 줄이 끝나거나 다음 질문이 시작되면 그 답은 끝난 것이다.
    return '\n'.join(turns) + '\nA:', ('\n', 'Q:')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/v1/models'):
            mid = STATE['model_id']
            data = [] if not mid else [{'id': mid, 'object': 'model', 'owned_by': 'huggingface',
                                        'created': int((STATE['loaded_at'] or 0) / 1000)}]
            return self._send(200, {'object': 'list', 'data': data})
        if self.path.startswith('/admin/state'):
            used = torch.cuda.memory_allocated() if torch.cuda.is_available() else 0
            return self._send(200, {**STATE, 'cuda_bytes': int(used)})
        if self.path.startswith('/health'):
            return self._send(200, {'ok': STATE['model_id'] is not None})
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            return self._send(400, {'error': 'invalid json'})

        if self.path.startswith('/admin/load'):
            with LOCK:
                try:
                    return self._send(200, load(body['model_id']))
                except Exception as e:
                    unload()
                    return self._send(500, {'error': type(e).__name__, 'detail': str(e)[:500],
                                            'trace': traceback.format_exc()[-800:]})
        if self.path.startswith('/admin/unload'):
            with LOCK:
                unload()
                return self._send(200, {'unloaded': True})

        chat = self.path.startswith('/v1/chat/completions')
        if not (chat or self.path.startswith('/v1/completions')):
            return self._send(404, {'error': 'not found'})

        loaded = STATE['model_id']
        if not loaded:
            return self._send(503, {'error': {'message': 'no model loaded', 'type': 'model_unavailable'}})
        want = body.get('model')
        if want and want != loaded:
            # 요청한 모델이 실려 있지 않다. 다른 모델의 답으로 대체하지 않는다.
            return self._send(404, {'error': {'message': 'model %r is not served; loaded=%r' % (want, loaded),
                                              'type': 'model_not_found'}})
        template_kwargs = body.get('chat_template_kwargs') if isinstance(body.get('chat_template_kwargs'), dict) else None
        prompt, stop = to_prompt(body['messages'], template_kwargs) if chat else (body.get('prompt', ''), ())
        stop = tuple(body.get('stop') or stop)
        want_tokens = int(body.get('max_tokens') or MAX_NEW)
        with LOCK:
            try:
                text, raw, pin, pout = generate(prompt, min(want_tokens, 512), stop)
            except Exception as e:
                return self._send(500, {'error': {'message': type(e).__name__ + ': ' + str(e)[:300],
                                                  'type': 'inference_error'}})
        now = int(time.time())
        usage = {'prompt_tokens': pin, 'completion_tokens': pout, 'total_tokens': pin + pout}
        if chat:
            return self._send(200, {'id': 'chatcmpl-m5-%d' % now, 'object': 'chat.completion', 'created': now,
                                    'model': loaded, 'usage': usage,
                                    'choices': [{'index': 0, 'finish_reason': 'stop',
                                                 'message': {'role': 'assistant', 'content': text}}],
                                    'ainize_raw': raw})
        return self._send(200, {'id': 'cmpl-m5-%d' % now, 'object': 'text_completion', 'created': now,
                                'model': loaded, 'usage': usage,
                                'choices': [{'index': 0, 'finish_reason': 'stop', 'text': text}],
                                'ainize_raw': raw})


if __name__ == '__main__':
    print('m5 runtime on :%d device=%s' % (PORT, DEVICE), flush=True)
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
