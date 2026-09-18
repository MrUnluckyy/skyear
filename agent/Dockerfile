FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY skyear ./skyear
RUN useradd -r -u 1000 skyear && mkdir -p /data && chown skyear /data

# Deliberately no USER. The agent drops to skyear itself at startup, after
# taking ownership of /data - which is the only way to cope with Home
# Assistant mounting its own root-owned /data over the one built here.
# The setup page lives at /setup on this port; setup.html ships inside skyear/.
EXPOSE 8088
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-m", "skyear.main"]
