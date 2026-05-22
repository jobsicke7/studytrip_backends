export function isWithinRadius(
  latitude: number,
  longitude: number,
  schoolLat: number,
  schoolLng: number,
  radiusMeters: number
): boolean {
  const earthRadiusMeters = 6371000;
  const lat1 = toRadians(latitude);
  const lat2 = toRadians(schoolLat);
  const deltaLat = toRadians(schoolLat - latitude);
  const deltaLng = toRadians(schoolLng - longitude);

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = earthRadiusMeters * c;

  return distance <= radiusMeters;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
