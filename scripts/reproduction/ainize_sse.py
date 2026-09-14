import json


def consume_chat(lines, patch_id):
    event = "message"
    data = []
    total_bytes = 0
    result = None
    finished = False
    content_seen = False
    for raw in lines:
        total_bytes += len(raw)
        if total_bytes > 32 * 1024 * 1024:
            raise ValueError("Chat stream exceeds 32 MiB")
        line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if line:
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
            continue
        if not data:
            event = "message"
            continue
        payload = "\n".join(data)
        data = []
        frame_event, event = event, "message"
        if payload == "[DONE]":
            if not finished or not content_seen or result is None:
                raise ValueError("Chat stream omitted completion evidence")
            answer = result.get("patched")
            if result.get("mode") != "patched" or result.get("patch_ids", [result.get("patch_id")]) != [patch_id]:
                raise ValueError("Chat returned a different mode or knowledge")
            if not isinstance(answer, dict) or not isinstance(answer.get("content"), str) or not answer["content"].strip() or not answer.get("model"):
                raise ValueError("Chat omitted its model answer")
            if answer.get("truncated"):
                raise ValueError("Chat answer was truncated")
            return result
        parsed = json.loads(payload)
        if not isinstance(parsed, dict) or parsed.get("error") or frame_event == "error":
            raise ValueError("Node reported a chat stream error")
        if frame_event == "ainize.result":
            if result is not None:
                raise ValueError("Duplicate final chat result")
            result = parsed
            continue
        if parsed.get("object") != "chat.completion.chunk" or not isinstance(parsed.get("choices"), list):
            raise ValueError("Invalid chat stream frame")
        for choice in parsed["choices"]:
            if choice.get("index") != 0:
                raise ValueError("Expected one patched completion")
            if isinstance(choice.get("delta", {}).get("content"), str) and choice["delta"]["content"]:
                content_seen = True
            if choice.get("finish_reason") is not None:
                if choice["finish_reason"] != "stop":
                    raise ValueError("Model did not finish normally")
                finished = True
    raise ValueError("Chat stream ended before [DONE]")
