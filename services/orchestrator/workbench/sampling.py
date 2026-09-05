from typing import Any


def validated_steps(value: Any, default: int, minimum: int, maximum: int) -> int:
    """Reject fractional, boolean and out-of-range values before GPU work."""
    if value is None:
        return default
    try:
        steps = int(value)
        valid = not isinstance(value, bool) and float(value) == steps
    except (TypeError, ValueError, OverflowError):
        valid = False
        steps = 0
    if not valid or not minimum <= steps <= maximum:
        raise ValueError(f"Sampling steps must be an integer between {minimum} and {maximum}")
    return steps
