/**
 * Paths on the GoCourt booking API that this service calls. All paths are
 * relative to a base URL that already includes the `/api` prefix
 * (for example https://api.example.com/api).
 *
 * Front-desk bookings use POST /bookings/manual, and front-desk cancellations
 * use DELETE /clubs/:clubId/bookings/:bookingId.
 */

export const gocourtRoutes = {
  login: "/auth/login",
  myClubs: "/clubs/my/clubs",
  operatingHours(clubId: number, date: string): string {
    return `/clubs/${clubId}/operating-hours/${date}`;
  },
  bookingRules(clubId: number): string {
    return `/clubs/${clubId}/booking-rules`;
  },
  /** Owner schedule: every active court and that day's bookings. */
  schedule(clubId: number): string {
    return `/clubs/${clubId}/availability`;
  },
  /**
   * Active pricing rules. Court `price_per_hour` is often null; the booking
   * price comes from these rules.
   */
  pricingRules(clubId: number): string {
    return `/clubs/${clubId}/pricing-rules`;
  },
  clubBookings(clubId: number): string {
    return `/clubs/${clubId}/bookings`;
  },
  cancelClubBooking(clubId: number, bookingId: number): string {
    return `/clubs/${clubId}/bookings/${bookingId}`;
  },
  manualBooking: "/bookings/manual",
} as const;
