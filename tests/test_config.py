from app.config import QWEN_BASE_MODELS, Settings


def test_qwen_06b_model_can_be_selected_from_environment(monkeypatch):
    model_id = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    assert model_id in QWEN_BASE_MODELS

    monkeypatch.setenv("TTS_MODEL", model_id)

    assert Settings.from_env().model_id == model_id
