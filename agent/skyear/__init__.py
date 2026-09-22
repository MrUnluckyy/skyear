__version__ = "0.3.2"

# Where SkyEar lives. An agent installed from the published image has no
# config file, so without a default it cannot pair at all - which is exactly
# what happened: "camera saved, but pairing failed: no cloud url configured".
# Override with cloud.url in config for a self-hosted deployment.
DEFAULT_CLOUD_URL = "https://kzeghlzmbxeldrmoxdrl.supabase.co"
