STAGES = frozenset({"connect", "content_type", "stream", "receipt_validation", "receipt_write", "result"})
CODES = frozenset({"interrupted", "connect_timeout", "read_timeout", "request_timeout", "total_timeout", "tls_error", "connection_or_read_error", "request_error", "internal_error"})


def failure_label(stage, status=None):
    if stage == "http" and type(status) is int and 100 <= status <= 599:
        return "http_" + str(status)
    return stage + "_error" if stage in STAGES else "internal_error"


def safe_failure_code(error):
    code = str(error)
    if code in CODES or code in {stage + "_error" for stage in STAGES}:
        return code
    if len(code) == 8 and code.startswith("http_") and code[5:].isdigit() and 100 <= int(code[5:]) <= 599:
        return code
    return "interrupted"
