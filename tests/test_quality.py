import numpy as np
import soundfile as sf

from app.quality import check_reference, evaluate, resample, signal_metrics, word_match
from tests.conftest import FakeTranscriber

SR = 24_000


def speech_like(seconds=10.0, noise=1e-4, amp=0.3, lead=0.3, trail=0.3, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * seconds)) / SR
    audio = amp * np.sin(2 * np.pi * 200 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    audio[: int(SR * lead)] = 0
    audio[len(audio) - int(SR * trail):] = 0
    return (audio + noise * rng.standard_normal(audio.size)).astype(np.float32)


def test_signal_metrics_clean_recording():
    m = signal_metrics(speech_like(), SR)
    assert m["duration_s"] == 10.0
    assert m["snr_db"] > 40
    assert m["clipping_pct"] == 0
    assert 0.2 <= m["leading_silence_s"] <= 0.4


def test_signal_metrics_detects_clipping_and_noise():
    clipped = np.clip(speech_like(amp=3.0), -1, 1)
    assert signal_metrics(clipped, SR)["clipping_pct"] > 1
    noisy = speech_like(noise=0.05, lead=0, trail=0)
    assert signal_metrics(noisy, SR)["snr_db"] < 25


def test_word_match_ignores_case_punctuation_and_accents():
    assert word_match("Hello, world! Qué tal?", "hello world que tal") == 1.0
    assert word_match("one two three four", "one two four") < 1.0
    assert word_match("", "") == 1.0


def test_evaluate_verdicts():
    good = {"duration_s": 15, "snr_db": 50, "clipping_pct": 0, "speech_dbfs": -20}
    assert evaluate(good, "a b c", "a b c")[0] == "ok"
    verdict, warnings, match = evaluate(good, "a b c d e", "x y z")
    assert verdict == "bad" and match < 0.8 and warnings
    assert evaluate({**good, "duration_s": 5}, "a", "a")[0] == "warn"
    assert evaluate({**good, "clipping_pct": 2}, "a", None)[0] == "bad"


def test_resample_length():
    assert resample(np.zeros(24_000, dtype=np.float32), 24_000, 16_000).size == 16_000


def test_check_reference_end_to_end(tmp_path):
    path = tmp_path / "ref.wav"
    sf.write(str(path), speech_like(), SR)
    report = check_reference(path, "Hello, this is my voice.", FakeTranscriber())
    assert report.word_match == 1.0
    assert report.verdict == "ok"


def test_check_reference_survives_transcriber_failure(tmp_path):
    class Broken:
        def transcribe(self, audio):
            raise RuntimeError("boom")

    path = tmp_path / "ref.wav"
    sf.write(str(path), speech_like(), SR)
    report = check_reference(path, "text", Broken())
    assert report.transcription is None and report.word_match is None
