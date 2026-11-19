import io

import numpy as np
import soundfile as sf

from app.audio import concat_with_pauses, encode_wav, peak_normalize, to_mono_float32


def test_to_mono_handles_frames_by_channels_and_channels_by_frames():
    stereo_fc = np.ones((1000, 2), dtype=np.float32)
    stereo_cf = np.ones((2, 1000), dtype=np.float32)
    assert to_mono_float32(stereo_fc).shape == (1000,)
    assert to_mono_float32(stereo_cf).shape == (1000,)
    assert to_mono_float32([[0.5, 0.5, 0.5]]).shape == (3,)


def test_concat_inserts_silence():
    a = np.ones(100, dtype=np.float32)
    out = concat_with_pauses([a, a, a], sample_rate=1000, pause_ms=10)
    assert out.size == 300 + 2 * 10
    assert np.all(out[100:110] == 0)


def test_concat_empty():
    assert concat_with_pauses([], 24000, 250).size == 0


def test_peak_normalize():
    out = peak_normalize(np.array([0.1, -0.2], dtype=np.float32), peak=0.8)
    assert np.isclose(np.max(np.abs(out)), 0.8)
    silent = np.zeros(10, dtype=np.float32)
    assert np.array_equal(peak_normalize(silent), silent)


def test_encode_wav_roundtrip():
    audio = np.linspace(-1, 1, 2400, dtype=np.float32)
    data, sr = sf.read(io.BytesIO(encode_wav(audio, 24000)))
    assert sr == 24000
    assert data.shape == (2400,)
