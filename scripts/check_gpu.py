"""Check that PyTorch can access the GPU inside the container.

Usage: docker compose run --rm tts python scripts/check_gpu.py
"""

import sys

import torch

print(f"torch {torch.__version__} · CUDA build {torch.version.cuda}")
if not torch.cuda.is_available():
    print("ERROR: CUDA no disponible. Revisa el driver NVIDIA y la integración GPU de Docker Desktop (WSL2).")
    sys.exit(1)
for i in range(torch.cuda.device_count()):
    props = torch.cuda.get_device_properties(i)
    print(f"GPU {i}: {props.name} · {props.total_memory / 1024**3:.1f} GB · compute {props.major}.{props.minor}")
print(f"bf16 soportado: {torch.cuda.is_bf16_supported()}")
x = torch.randn(1024, 1024, device="cuda")
print(f"Prueba matmul OK: {(x @ x).sum().item():.2f}")
try:
    import flash_attn

    print(f"flash-attn {flash_attn.__version__} instalado")
except ImportError:
    print("flash-attn no instalado (opcional; se usará sdpa)")
