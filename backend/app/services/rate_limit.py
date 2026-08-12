"""Per-user question quotas enforced in Redis without storing question content."""

import uuid
from dataclasses import dataclass
from typing import Protocol

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import Settings

logger = structlog.get_logger(__name__)

_MINUTE_SECONDS = 60
_DAY_SECONDS = 86_400


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    """The outcome of one quota check."""

    allowed: bool
    retry_after_seconds: int
    scope: str


class RateLimiterProtocol(Protocol):
    async def check_question(self, user_id: uuid.UUID) -> RateLimitDecision: ...

    async def close(self) -> None: ...


class AllowAllRateLimiter:
    """Explicit no-op limiter used when quotas are disabled."""

    async def check_question(self, user_id: uuid.UUID) -> RateLimitDecision:
        del user_id
        return RateLimitDecision(allowed=True, retry_after_seconds=0, scope="disabled")

    async def close(self) -> None:
        return None


class RedisRateLimiter:
    """Fixed-window counters keyed only by user id, never by question text.

    Redis holds nothing but opaque counters. A Redis outage fails open so an
    infrastructure problem degrades billing protection rather than denying every
    authenticated user; the outage is logged for alerting.
    """

    def __init__(self, *, client: Redis, settings: Settings) -> None:
        self._client = client
        self._per_minute = settings.question_rate_limit_per_minute
        self._per_day = settings.question_rate_limit_per_day

    @classmethod
    def from_settings(cls, settings: Settings) -> "RedisRateLimiter":
        client = Redis.from_url(
            settings.redis_url.get_secret_value(),
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
            health_check_interval=30,
        )
        return cls(client=client, settings=settings)

    async def check_question(self, user_id: uuid.UUID) -> RateLimitDecision:
        try:
            minute = await self._increment(f"codenaut:rl:q:m:{user_id}", _MINUTE_SECONDS)
            if minute > self._per_minute:
                return RateLimitDecision(
                    allowed=False, retry_after_seconds=_MINUTE_SECONDS, scope="minute"
                )
            day = await self._increment(f"codenaut:rl:q:d:{user_id}", _DAY_SECONDS)
            if day > self._per_day:
                return RateLimitDecision(
                    allowed=False, retry_after_seconds=_DAY_SECONDS, scope="day"
                )
        except (OSError, RedisError) as error:
            logger.warning("rate_limit_unavailable", error_type=type(error).__name__)
            return RateLimitDecision(allowed=True, retry_after_seconds=0, scope="unavailable")
        return RateLimitDecision(allowed=True, retry_after_seconds=0, scope="allowed")

    async def _increment(self, key: str, window_seconds: int) -> int:
        pipeline = self._client.pipeline()
        pipeline.incr(key)
        pipeline.expire(key, window_seconds, nx=True)
        results = await pipeline.execute()
        return int(results[0])

    async def close(self) -> None:
        try:
            await self._client.aclose()
        except (OSError, RedisError) as error:
            logger.warning("rate_limit_close_failed", error_type=type(error).__name__)


def create_rate_limiter(settings: Settings) -> RateLimiterProtocol:
    """Build the limiter the configuration asks for."""
    if not settings.question_rate_limit_enabled:
        return AllowAllRateLimiter()
    return RedisRateLimiter.from_settings(settings)
