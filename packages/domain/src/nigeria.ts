/**
 * Nigerian states (36 + FCT) and reference places with approximate centroids.
 * Coordinates are approximate public city/area centroids for typed-location search,
 * never a seller's home address.
 */
export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River',
  'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano',
  'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
  'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
] as const;

export type NigerianState = (typeof NIGERIAN_STATES)[number];

export function isNigerianState(value: string): value is NigerianState {
  return (NIGERIAN_STATES as readonly string[]).includes(value);
}

export function stateLabel(state: string): string {
  return state === 'FCT' ? 'Abuja (FCT)' : state;
}

export interface ReferencePlace {
  name: string;
  state: NigerianState;
  kind: 'city' | 'area';
  lat: number;
  lng: number;
  /** Lower = larger / more commonly searched. */
  rank: number;
}

export const REFERENCE_PLACES: readonly ReferencePlace[] = [
  { name: 'Umuahia', state: 'Abia', kind: 'city', lat: 5.525, lng: 7.4922, rank: 40 },
  { name: 'Aba', state: 'Abia', kind: 'city', lat: 5.1066, lng: 7.3667, rank: 12 },
  { name: 'Yola', state: 'Adamawa', kind: 'city', lat: 9.2035, lng: 12.4954, rank: 35 },
  { name: 'Uyo', state: 'Akwa Ibom', kind: 'city', lat: 5.0377, lng: 7.9128, rank: 20 },
  { name: 'Awka', state: 'Anambra', kind: 'city', lat: 6.2104, lng: 7.0741, rank: 30 },
  { name: 'Onitsha', state: 'Anambra', kind: 'city', lat: 6.1498, lng: 6.7857, rank: 10 },
  { name: 'Nnewi', state: 'Anambra', kind: 'city', lat: 6.0177, lng: 6.9184, rank: 45 },
  { name: 'Bauchi', state: 'Bauchi', kind: 'city', lat: 10.3158, lng: 9.8442, rank: 33 },
  { name: 'Yenagoa', state: 'Bayelsa', kind: 'city', lat: 4.9267, lng: 6.2676, rank: 38 },
  { name: 'Makurdi', state: 'Benue', kind: 'city', lat: 7.7322, lng: 8.5391, rank: 32 },
  { name: 'Maiduguri', state: 'Borno', kind: 'city', lat: 11.8311, lng: 13.151, rank: 18 },
  { name: 'Calabar', state: 'Cross River', kind: 'city', lat: 4.9757, lng: 8.3417, rank: 22 },
  { name: 'Asaba', state: 'Delta', kind: 'city', lat: 6.1981, lng: 6.7273, rank: 26 },
  { name: 'Warri', state: 'Delta', kind: 'city', lat: 5.5167, lng: 5.75, rank: 16 },
  { name: 'Abakaliki', state: 'Ebonyi', kind: 'city', lat: 6.3249, lng: 8.1137, rank: 39 },
  { name: 'Benin City', state: 'Edo', kind: 'city', lat: 6.335, lng: 5.6037, rank: 7 },
  { name: 'Ado-Ekiti', state: 'Ekiti', kind: 'city', lat: 7.6211, lng: 5.2214, rank: 36 },
  { name: 'Enugu', state: 'Enugu', kind: 'city', lat: 6.4584, lng: 7.5464, rank: 9 },
  { name: 'Nsukka', state: 'Enugu', kind: 'city', lat: 6.8567, lng: 7.3958, rank: 44 },
  { name: 'Abuja', state: 'FCT', kind: 'city', lat: 9.0765, lng: 7.3986, rank: 2 },
  { name: 'Wuse', state: 'FCT', kind: 'area', lat: 9.0643, lng: 7.4683, rank: 50 },
  { name: 'Garki', state: 'FCT', kind: 'area', lat: 9.03, lng: 7.49, rank: 50 },
  { name: 'Maitama', state: 'FCT', kind: 'area', lat: 9.0882, lng: 7.4934, rank: 50 },
  { name: 'Gwarinpa', state: 'FCT', kind: 'area', lat: 9.1099, lng: 7.4083, rank: 50 },
  { name: 'Kubwa', state: 'FCT', kind: 'area', lat: 9.155, lng: 7.322, rank: 50 },
  { name: 'Lugbe', state: 'FCT', kind: 'area', lat: 8.98, lng: 7.37, rank: 55 },
  { name: 'Gombe', state: 'Gombe', kind: 'city', lat: 10.2897, lng: 11.1673, rank: 37 },
  { name: 'Owerri', state: 'Imo', kind: 'city', lat: 5.484, lng: 7.0351, rank: 19 },
  { name: 'Dutse', state: 'Jigawa', kind: 'city', lat: 11.7562, lng: 9.339, rank: 48 },
  { name: 'Kaduna', state: 'Kaduna', kind: 'city', lat: 10.5105, lng: 7.4165, rank: 6 },
  { name: 'Zaria', state: 'Kaduna', kind: 'city', lat: 11.0855, lng: 7.7199, rank: 17 },
  { name: 'Kano', state: 'Kano', kind: 'city', lat: 12.0022, lng: 8.592, rank: 3 },
  { name: 'Katsina', state: 'Katsina', kind: 'city', lat: 12.9908, lng: 7.6018, rank: 29 },
  { name: 'Birnin Kebbi', state: 'Kebbi', kind: 'city', lat: 12.4539, lng: 4.1975, rank: 46 },
  { name: 'Lokoja', state: 'Kogi', kind: 'city', lat: 7.8023, lng: 6.7333, rank: 41 },
  { name: 'Ilorin', state: 'Kwara', kind: 'city', lat: 8.4966, lng: 4.5426, rank: 11 },
  { name: 'Lagos', state: 'Lagos', kind: 'city', lat: 6.5244, lng: 3.3792, rank: 1 },
  { name: 'Ikeja', state: 'Lagos', kind: 'area', lat: 6.6018, lng: 3.3515, rank: 5 },
  { name: 'Lagos Island', state: 'Lagos', kind: 'area', lat: 6.4541, lng: 3.3947, rank: 14 },
  { name: 'Lekki', state: 'Lagos', kind: 'area', lat: 6.4698, lng: 3.5852, rank: 8 },
  { name: 'Victoria Island', state: 'Lagos', kind: 'area', lat: 6.4281, lng: 3.4219, rank: 15 },
  { name: 'Ikoyi', state: 'Lagos', kind: 'area', lat: 6.45, lng: 3.4333, rank: 21 },
  { name: 'Yaba', state: 'Lagos', kind: 'area', lat: 6.5095, lng: 3.3711, rank: 13 },
  { name: 'Surulere', state: 'Lagos', kind: 'area', lat: 6.5, lng: 3.35, rank: 23 },
  { name: 'Ikorodu', state: 'Lagos', kind: 'area', lat: 6.6194, lng: 3.5105, rank: 24 },
  { name: 'Ajah', state: 'Lagos', kind: 'area', lat: 6.4672, lng: 3.5704, rank: 25 },
  { name: 'Festac', state: 'Lagos', kind: 'area', lat: 6.4667, lng: 3.2833, rank: 27 },
  { name: 'Lafia', state: 'Nasarawa', kind: 'city', lat: 8.4939, lng: 8.515, rank: 47 },
  { name: 'Keffi', state: 'Nasarawa', kind: 'city', lat: 8.8486, lng: 7.8736, rank: 49 },
  { name: 'Minna', state: 'Niger', kind: 'city', lat: 9.6139, lng: 6.5569, rank: 34 },
  { name: 'Abeokuta', state: 'Ogun', kind: 'city', lat: 7.1475, lng: 3.3619, rank: 13 },
  { name: 'Ota', state: 'Ogun', kind: 'city', lat: 6.6804, lng: 3.2356, rank: 31 },
  { name: 'Ijebu Ode', state: 'Ogun', kind: 'city', lat: 6.8194, lng: 3.9173, rank: 42 },
  { name: 'Akure', state: 'Ondo', kind: 'city', lat: 7.2571, lng: 5.2058, rank: 21 },
  { name: 'Osogbo', state: 'Osun', kind: 'city', lat: 7.7827, lng: 4.5418, rank: 28 },
  { name: 'Ile-Ife', state: 'Osun', kind: 'city', lat: 7.4824, lng: 4.5603, rank: 30 },
  { name: 'Ibadan', state: 'Oyo', kind: 'city', lat: 7.3775, lng: 3.947, rank: 4 },
  { name: 'Ogbomoso', state: 'Oyo', kind: 'city', lat: 8.1335, lng: 4.2407, rank: 27 },
  { name: 'Jos', state: 'Plateau', kind: 'city', lat: 9.8965, lng: 8.8583, rank: 14 },
  { name: 'Port Harcourt', state: 'Rivers', kind: 'city', lat: 4.8156, lng: 7.0498, rank: 3 },
  { name: 'Sokoto', state: 'Sokoto', kind: 'city', lat: 13.0059, lng: 5.2476, rank: 25 },
  { name: 'Jalingo', state: 'Taraba', kind: 'city', lat: 8.8937, lng: 11.3604, rank: 43 },
  { name: 'Damaturu', state: 'Yobe', kind: 'city', lat: 11.747, lng: 11.9608, rank: 48 },
  { name: 'Gusau', state: 'Zamfara', kind: 'city', lat: 12.1628, lng: 6.6614, rank: 44 },
];

/** Approximate state centroid = the state's highest-ranked reference place. */
export function statePlace(state: NigerianState): ReferencePlace | undefined {
  return REFERENCE_PLACES.filter((p) => p.state === state).sort((a, b) => a.rank - b.rank)[0];
}

/** Great-circle distance in km (used for display; search uses PostGIS). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Rounds a distance for display so it never reveals a precise location. */
export function approximateDistanceLabel(km: number): string {
  if (km < 2) return 'Under 2 km';
  if (km < 10) return `About ${Math.round(km)} km`;
  if (km < 100) return `About ${Math.round(km / 5) * 5} km`;
  return `About ${Math.round(km / 50) * 50} km`;
}

/** Reduces precision of a coordinate to ~1.1 km so public shop locations stay approximate. */
export function coarsenCoordinate(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
