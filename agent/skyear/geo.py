import math

EARTH_R = 6371000.0
SPEED_OF_SOUND = 343.0  # m/s at ~20C; ~331 m/s at 0C
FT = 0.3048


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def slant(sensor, lat, lon, alt_m):
    """Returns (slant_m, horizontal_m, elevation_angle_deg, bearing_deg)."""
    h = haversine_m(sensor["lat"], sensor["lon"], lat, lon)
    dz = alt_m - sensor["alt_m"]
    s = math.hypot(h, dz)
    elev = math.degrees(math.atan2(dz, h)) if h > 0 else 90.0
    return s, h, elev, bearing_deg(sensor["lat"], sensor["lon"], lat, lon)
