/**
 * The API's database role must be least-privilege (DEC-074,
 * docs/INFRASTRUCTURE_DECISION.md §2.1). In staging and production the API
 * refuses to start when its role:
 *   - is a superuser,
 *   - can bypass row-level security, or
 *   - owns the `app` schema (it could then run DDL, and RLS would not apply).
 * The schema owner is used only by the release step (`MIGRATION_DATABASE_URL`).
 */
import type pg from 'pg';

export type RoleCheck = { role: string; problems: string[] };

export async function checkRuntimeRole(pool: pg.Pool): Promise<RoleCheck> {
  // pg_has_role(…, 'USAGE') covers inherited membership: a member of the owner IS the owner for privileges.
  const { rows } = await pool.query<{
    role: string;
    superuser: boolean;
    bypassrls: boolean;
    owns_schema: boolean;
    owns_tables: boolean;
    can_create: boolean;
    broad_data_roles: boolean;
  }>(
    `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls,
            COALESCE((SELECT pg_has_role(current_user, n.nspowner, 'USAGE') FROM pg_namespace n WHERE n.nspname = 'app'), false) AS owns_schema,
            EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'app' AND c.relkind = 'r' AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owns_tables,
            CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN has_schema_privilege(current_user, 'app', 'CREATE') ELSE false END AS can_create,
            EXISTS (SELECT 1 FROM pg_roles g WHERE g.rolname IN ('pg_write_all_data', 'pg_read_all_data')
                     AND pg_has_role(current_user, g.oid, 'USAGE')) AS broad_data_roles
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0];
  if (!r) return { role: 'unknown', problems: ['the current database role could not be inspected'] };
  const problems: string[] = [];
  if (r.superuser) problems.push('is a superuser');
  if (r.bypassrls) problems.push('can bypass row-level security');
  if (r.owns_schema || r.owns_tables) problems.push('owns the app schema or its tables, directly or through membership (use the runtime role; the owner is for migrations only)');
  if (r.can_create) problems.push('can create objects in the app schema');
  if (r.broad_data_roles) problems.push('is a member of pg_read_all_data / pg_write_all_data');
  return { role: r.role, problems };
}
