import math

from skyear.geo import EARTH_R

SENSOR = {"lat": 54.6872, "lon": 25.2797, "alt_m": 124.0}
DEG_M = EARTH_R * math.pi / 180


def m_to_lat(m):
    return m / DEG_M


def m_to_lon(m, at_lat):
    return m / (DEG_M * math.cos(math.radians(at_lat)))


class FakeAdsb:
    """One aircraft on a straight, level, eastbound track past the sensor.

    Position is analytic, so tests assert against exact geometry rather than
    against a recorded fixture.
    """

    def __init__(self, hex_id="4ca7b1", speed_mps=200.0, alt_m=1000.0,
                 t_closest=0.0, offset_north_m=1500.0, sensor=SENSOR, meta=None,
                 blind_s=0.0):
        self.hex = hex_id
        self.speed = speed_mps
        self.alt = alt_m
        self.t_closest = t_closest
        self.offset_north_m = offset_north_m
        self.sensor = sensor
        self.meta = meta or {"flight": "BTI4TK", "type": "BCS3", "reg": "YL-AAS"}
        self.now = t_closest
        self.blind_s = blind_s   # how long the feed has been down, if at all

    def position_at(self, hx, t, max_gap_s=30.0):
        if hx != self.hex:
            return None
        lat = self.sensor["lat"] + m_to_lat(self.offset_north_m)
        east_m = self.speed * (t - self.t_closest)
        lon = self.sensor["lon"] + m_to_lon(east_m, lat)
        return (lat, lon, self.alt)

    def snapshot(self):
        lat, lon, alt = self.position_at(self.hex, self.now)
        return {self.hex: (dict(self.meta), (self.now, lat, lon, alt))}

    def blind_for(self, now=None):
        return self.blind_s
