"""Authentication API response contracts."""

import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

AVATAR_COLORS = (
    "#6C5DD3",
    "#4F6DF5",
    "#17B4C9",
    "#1FAA6F",
    "#E0922B",
    "#E0517A",
    "#6B7280",
    "#C042C4",
)
_MIN_PRINTABLE_CODEPOINT = 32


class AccessTokenResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    github_user_id: int | None
    github_login: str | None
    display_name: str | None
    avatar_url: str | None
    email: str | None
    linked_providers: list[str]
    custom_display_name: str | None
    avatar_color: str | None


class AuthenticationResponse(AccessTokenResponse):
    user: UserResponse


class UpdateProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    custom_display_name: str | None = Field(default=None, max_length=100)
    avatar_color: str | None = None

    @field_validator("custom_display_name")
    @classmethod
    def validate_custom_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("custom_display_name_blank")
        if any(ord(character) < _MIN_PRINTABLE_CODEPOINT for character in stripped):
            raise ValueError("custom_display_name_control_characters")
        return stripped

    @field_validator("avatar_color")
    @classmethod
    def validate_avatar_color(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value not in AVATAR_COLORS:
            raise ValueError("avatar_color_unsupported")
        return value
