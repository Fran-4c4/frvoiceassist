# syntax=docker/dockerfile:1.7
#
# Imagen con Qwen3-TTS + FastAPI y soporte GPU NVIDIA.
# Las ruedas de PyTorch para CUDA traen sus propias librerías CUDA/cuDNN, así que basta con una
# imagen Python ligera; el driver lo aporta el host a través del NVIDIA Container Toolkit.
FROM python:3.12-slim-bookworm

ARG TORCH_VERSION=2.8.0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
# flash-attn es opcional (ahorra algo de VRAM). Si se activa, poner también TTS_ATTN=flash_attention_2.
ARG INSTALL_FLASH_ATTN=false
ARG FLASH_ATTN_WHEEL=https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.8cxx11abiTRUE-cp312-cp312-linux_x86_64.whl

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_CACHE_DIR=/root/.cache/pip \
    HF_HOME=/models/hf \
    XDG_CACHE_HOME=/models/cache \
    HOME=/home/app \
    WORKSPACE_DIR=/workspace

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg sox libsndfile1 curl \
    && rm -rf /var/lib/apt/lists/*

# El contenedor puede ejecutarse con el UID/GID del usuario del host (Linux) para que los ficheros que escribe
# en ~/frvoiceassist sean suyos: estas carpetas deben ser escribibles por cualquier usuario.
RUN mkdir -p /models/hf /models/cache /workspace /home/app && chmod -R 777 /models /workspace /home/app

WORKDIR /app

# 1) PyTorch con CUDA (capa grande, se cachea mientras no cambie la versión)
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" --index-url "${TORCH_INDEX_URL}" \
    && printf "torch==%s\ntorchaudio==%s\n" "${TORCH_VERSION}" "${TORCH_VERSION}" > /etc/pip-constraints.txt

# 2) Qwen3-TTS + API + herramientas de test
COPY requirements.txt requirements-gpu.txt requirements-dev.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -c /etc/pip-constraints.txt -r requirements.txt -r requirements-gpu.txt -r requirements-dev.txt

# 3) flash-attn opcional (rueda precompilada; compilarlo desde fuente tarda mucho)
RUN --mount=type=cache,target=/root/.cache/pip \
    if [ "${INSTALL_FLASH_ATTN}" = "true" ]; then pip install -c /etc/pip-constraints.txt "${FLASH_ATTN_WHEEL}"; fi

# 4) Código
COPY pyproject.toml ./
COPY app ./app
COPY tests ./tests
COPY scripts ./scripts

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "app.main:main_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
