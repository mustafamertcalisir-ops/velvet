/**
 * Member profile provisioning — once, at activation (DEC-049).
 *
 * Built with the sanctioned whitelist constructor (createPublicProfile) from
 * a narrow source: first name, derived age, occupation, city label, work
 * description, interests, intents. Never the surname, date of birth, phone,
 * Instagram, referral or written answers.
 *
 * Profile photos are promoted explicitly: current, non-rejected application
 * profile photos are copied to member storage keys. Verification photos never.
 * A Dating member gets a private Dating settings record seeded from the
 * application's answers; their own identity is asked in Dating setup (DEC-058).
 */
import { canAccessMemberProduct } from '@/domain/admission/access';
import { seekingFromMeet } from '@/domain/member/dating';
import { createPublicProfile, derivePublicProfileSource } from '@/domain/profile/publicProfile';
import type { CalendarDate } from '@/domain/validation/dateOfBirth';
import type { Db } from '../db/pool';
import { newId } from '../lib/crypto';
import { finalKey } from '../media/pipeline';
import type { ObjectStore } from '../media/objectStore';
import { applicationOf, membershipOf } from '../records';
import type { MediaRow, PrivateRow } from '../admission/service';

export async function provisionMember(
  db: Db,
  accountId: string,
  ctx: { at: string; today: CalendarDate; store: ObjectStore },
): Promise<string | null> {
  const existing = await db.query<{ id: string }>('SELECT id FROM app.member_profiles WHERE account_id = $1', [accountId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const app = await applicationOf(db, accountId);
  const membership = await membershipOf(db, accountId);
  if (!app || !canAccessMemberProduct(app.status, membership)) return null;
  const priv = (await db.query<PrivateRow>('SELECT * FROM app.application_private_data WHERE application_id = $1', [app.id])).rows[0];
  if (!priv) return null;

  const profile = createPublicProfile({
    status: app.status,
    id: newId('mem'),
    userId: accountId,
    source: derivePublicProfileSource(
      {
        firstName: priv.first_name,
        lastName: priv.last_name,
        dateOfBirth: priv.date_of_birth,
        city: priv.city,
        occupation: priv.occupation,
        interests: priv.interests,
        workDescription: priv.work_description,
        intents: priv.intents,
      },
      ctx.today,
    ),
    policy: 'first_name',
    now: ctx.at,
  });
  // Explicit columns. Age is not stored: it is derived from the private date of birth at read time.
  await db.query(
    `INSERT INTO app.member_profiles
       (id, account_id, display_name, occupation, city_label, bio, known_for, interests, intents, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'visible', $10, $10)`,
    [profile.id, accountId, profile.displayName, profile.occupation, profile.cityLabel, profile.bio, profile.knownFor, profile.interests, profile.intents, ctx.at],
  );

  const { rows: photos } = await db.query<MediaRow & { content_type: string }>(
    `SELECT * FROM app.application_media
     WHERE application_id = $1 AND purpose = 'profile' AND retired_at IS NULL AND purged_at IS NULL AND position >= 0
       AND moderation_status <> 'rejected'
     ORDER BY position`,
    [app.id],
  );
  for (const [position, m] of photos.entries()) {
    const id = newId('mmd');
    const key = finalKey('PROFILE_MEDIA', profile.id, id);
    // Application photos and member photos live in the same private bucket; verification media is never copied.
    await ctx.store.copy({ bucket: 'media', key: m.storage_key }, { bucket: 'media', key });
    await db.query(
      `INSERT INTO app.member_media (id, member_id, type, storage_key, content_type, width, height, position, source_application_media_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, profile.id, m.type, key, m.content_type, m.width, m.height, position, m.id, ctx.at],
    );
  }

  if (profile.intents.includes('dating')) {
    const prefs = (
      await db.query<{ meet: string[]; age_min: number; age_max: number }>(
        'SELECT meet, age_min, age_max FROM app.application_dating_preferences WHERE application_id = $1',
        [app.id],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO app.dating_settings (member_id, seeking, age_min, age_max, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
      [profile.id, prefs ? seekingFromMeet(prefs.meet) : [], prefs?.age_min ?? null, prefs?.age_max ?? null, ctx.at],
    );
  }
  return profile.id;
}
