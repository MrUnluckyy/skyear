FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY skyear ./skyear
RUN useradd -r -u 1000 skyear && mkdir -p /data && chown skyear /data
USER skyear
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-m", "skyear.main"]
