/**
 * Single-user mode placeholder. Until real auth lands, every API call is
 * implicitly attributed to this fixed UUID, and the migration script seeds
 * a `users` row with this id.
 */
export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
