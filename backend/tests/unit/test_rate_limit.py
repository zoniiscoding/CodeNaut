"""Per-user question quota behavior, including fail-open on Redis outage."""

import uuid
from typing import cast

import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.services.rate_limit import (
    AllowAllRateLimiter,
    RedisRateLimiter,
    create_rate_limiter,
)
from tests.conftest import make_settings


class FakePipeline:
    def __init__(self, store: dict[str, int], fail: bool) -> None:
        self._store = store
        self._fail = fail
        self._key: str | None = None

    def incr(self, key: str) -> None:
        self._key = key

    def expire(self, key: str, seconds: int, nx: bool = False) -> None:
        del key, seconds, nx

    async def execute(self) -> list[int]:
        if self._fail:
            raise RedisError("unavailable")
        assert self._key is not None
        self._store[self._key] = self._store.get(self._key, 0) + 1
        return [self._store[self._key]]


class FakeRedis:
    def __init__(self, *, fail: bool = False) -> None:
        self.store: dict[str, int] = {}
        self.fail = fail
        self.closed = False

    def pipeline(self) -> FakePipeline:
        return FakePipeline(self.store, self.fail)

    async def aclose(self) -> None:
        self.closed = True


def limiter(client: FakeRedis, **overrides: object) -> RedisRateLimiter:
    settings = make_settings(**overrides)
    return RedisRateLimiter(client=cast(Redis, client), settings=settings)


async def test_requests_are_allowed_until_the_per_minute_quota_is_exceeded() -> None:
    client = FakeRedis()
    limits = limiter(client, question_rate_limit_per_minute=3)
    user_id = uuid.uuid4()

    decisions = [await limits.check_question(user_id) for _ in range(4)]

    assert [item.allowed for item in decisions] == [True, True, True, False]
    assert decisions[-1].scope == "minute"
    assert decisions[-1].retry_after_seconds == 60


async def test_daily_quota_is_enforced_after_the_minute_quota_passes() -> None:
    client = FakeRedis()
    limits = limiter(client, question_rate_limit_per_minute=100, question_rate_limit_per_day=2)
    user_id = uuid.uuid4()

    allowed_first = await limits.check_question(user_id)
    allowed_second = await limits.check_question(user_id)
    denied = await limits.check_question(user_id)

    assert allowed_first.allowed is True
    assert allowed_second.allowed is True
    assert denied.allowed is False
    assert denied.scope == "day"
    assert denied.retry_after_seconds == 86_400


async def test_quotas_are_scoped_per_user() -> None:
    client = FakeRedis()
    limits = limiter(client, question_rate_limit_per_minute=1)
    first_user = uuid.uuid4()
    second_user = uuid.uuid4()

    assert (await limits.check_question(first_user)).allowed is True
    assert (await limits.check_question(first_user)).allowed is False
    assert (await limits.check_question(second_user)).allowed is True


async def test_redis_outage_fails_open_rather_than_denying_every_user() -> None:
    limits = limiter(FakeRedis(fail=True))

    decision = await limits.check_question(uuid.uuid4())

    assert decision.allowed is True
    assert decision.scope == "unavailable"


async def test_quota_keys_never_contain_question_content() -> None:
    client = FakeRedis()
    limits = limiter(client)
    user_id = uuid.uuid4()

    await limits.check_question(user_id)

    assert all(str(user_id) in key for key in client.store)
    assert all(key.startswith("codenaut:rl:q:") for key in client.store)


async def test_close_releases_the_redis_client() -> None:
    client = FakeRedis()
    limits = limiter(client)

    await limits.close()

    assert client.closed is True


@pytest.mark.parametrize("enabled", [True, False])
def test_factory_honors_the_enabled_switch(enabled: bool) -> None:
    settings = make_settings(question_rate_limit_enabled=enabled)

    built = create_rate_limiter(settings)

    assert isinstance(built, AllowAllRateLimiter) is (not enabled)


async def test_disabled_limiter_always_allows() -> None:
    limits = AllowAllRateLimiter()

    decision = await limits.check_question(uuid.uuid4())

    assert decision.allowed is True
    assert decision.scope == "disabled"
    await limits.close()
