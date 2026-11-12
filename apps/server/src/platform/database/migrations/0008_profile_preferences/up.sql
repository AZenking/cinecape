-- 0008_profile_preferences(013-role-differentiated-settings,settings-contracts.md §2.1):
-- 个人偏好表,每 Profile 唯一;GET 未有行返回传输默认值(零写入);PUT 按「现值 + 覆盖层」
-- 合并语义写入(部分字段提交合法,与个人偏好页 playback/appearance 各自提交子集对齐)。
-- 无 CAS/幂等要求(013 契约仅 200;个人偏好非资产,后写覆盖前写属可接受语义)。

CREATE TABLE profile_preferences (
    household_id              TEXT NOT NULL REFERENCES household(id),
    profile_id                TEXT NOT NULL,
    default_audio_language    TEXT NOT NULL DEFAULT 'zh',
    default_subtitle_language TEXT NOT NULL DEFAULT 'zh',
    auto_play_next            INTEGER NOT NULL DEFAULT 1,
    theme_mode                TEXT NOT NULL DEFAULT 'system',
    poster_density            TEXT NOT NULL DEFAULT 'comfortable',
    updated_at                TEXT NOT NULL,
    PRIMARY KEY (household_id, profile_id),
    CONSTRAINT profile_preferences_auto_play_next_check CHECK (auto_play_next IN (0, 1)),
    CONSTRAINT profile_preferences_theme_mode_check     CHECK (theme_mode IN ('system', 'dark', 'light')),
    CONSTRAINT profile_preferences_poster_density_check CHECK (poster_density IN ('comfortable', 'compact')),
    FOREIGN KEY (household_id, profile_id) REFERENCES profile (household_id, id)
);
