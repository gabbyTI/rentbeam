-- Seed the default recurring charge catalog for production-safe initialization.
INSERT INTO "recurring_charge_types" (
  "id",
  "code",
  "name",
  "description",
  "active",
  "createdAt",
  "updatedAt"
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'PARKING',
    'Parking',
    'Assigned parking spot',
    true,
    NOW(),
    NOW()
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'STORAGE',
    'Storage',
    'Storage unit or locker',
    true,
    NOW(),
    NOW()
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'PET',
    'Pet fee',
    'Pet-related recurring charge',
    true,
    NOW(),
    NOW()
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'UTILITY',
    'Utility',
    'Utility or service charge',
    true,
    NOW(),
    NOW()
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    'OTHER',
    'Other',
    'Custom recurring charge',
    true,
    NOW(),
    NOW()
  )
ON CONFLICT ("code") DO NOTHING;
