// Ordered schema migrations. Versions live in PRAGMA user_version.
// Rule: never edit a shipped migration. Add a new one.
// Mark a migration `destructive: true` if it drops or rewrites data; the runner always backs up
// an existing database before applying any migration, and refuses to run a destructive one without that backup.
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  destructive: boolean;
  /** Rebuilding a table needs foreign keys off while it runs (SQLite's documented procedure). The runner checks them before committing. */
  foreignKeysOff?: boolean;
  up(db: DatabaseSync): void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    destructive: false,
    up(db) {
      db.exec(`
        CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO counters (name, value) VALUES ('seq', 0);

        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        CREATE TABLE areas (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          position REAL NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          is_sample INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          area_id TEXT NOT NULL REFERENCES areas(id),
          name TEXT NOT NULL,
          position REAL NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          is_sample INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          seq INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX projects_area ON projects(area_id);

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          area_id TEXT REFERENCES areas(id),
          project_id TEXT REFERENCES projects(id),
          status TEXT NOT NULL CHECK (status IN ('inbox','today','next','waiting','done')),
          prev_status TEXT,
          priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high')),
          due_date TEXT,
          next_action TEXT NOT NULL DEFAULT '',
          waiting_on TEXT NOT NULL DEFAULT '',
          links TEXT NOT NULL DEFAULT '[]',
          position REAL NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          seq INTEGER NOT NULL,
          is_sample INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          deleted_at TEXT,
          created_by TEXT NOT NULL,
          created_by_id TEXT NOT NULL,
          external_key TEXT
        );
        CREATE INDEX tasks_status ON tasks(status, position);
        CREATE INDEX tasks_seq ON tasks(seq);
        CREATE INDEX tasks_area ON tasks(area_id);
        CREATE UNIQUE INDEX tasks_external_key ON tasks(external_key) WHERE external_key IS NOT NULL;

        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          position REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX subtasks_task ON subtasks(task_id, position);

        CREATE TABLE activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          day TEXT NOT NULL,
          actor_kind TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_label TEXT NOT NULL,
          client_kind TEXT,
          claimed_name TEXT,
          session_id TEXT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          changes TEXT,
          rev INTEGER,
          summary TEXT NOT NULL,
          counts_as_write INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX activity_entity ON activity(entity_type, entity_id, id);
        CREATE INDEX activity_actor_day ON activity(actor_id, day);

        CREATE TABLE idempotency (
          actor_id TEXT NOT NULL,
          key TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          body_hash TEXT NOT NULL,
          status INTEGER NOT NULL,
          response TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (actor_id, key)
        );

        CREATE TABLE clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          scopes TEXT NOT NULL,
          limits TEXT NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );

        CREATE TABLE proposals (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES clients(id),
          body TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          confidence REAL,
          dedupe_key TEXT,
          source_url TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','duplicate')),
          seen_count INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          day TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          resolved_at TEXT,
          resolved_task_id TEXT,
          area_id TEXT
        );
        CREATE UNIQUE INDEX proposals_dedupe ON proposals(client_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
        CREATE INDEX proposals_status ON proposals(status, created_at);
      `);
    },
  },
  {
    version: 2,
    name: 'answers for question proposals',
    destructive: false,
    up(db) {
      db.exec('ALTER TABLE proposals ADD COLUMN answer TEXT');
    },
  },
  {
    version: 3,
    name: 'in progress status',
    destructive: true,
    foreignKeysOff: true,
    up(db) {
      db.exec(`
        CREATE TABLE tasks_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          area_id TEXT REFERENCES areas(id),
          project_id TEXT REFERENCES projects(id),
          status TEXT NOT NULL CHECK (status IN ('inbox','doing','today','next','waiting','done')),
          prev_status TEXT,
          priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high')),
          due_date TEXT,
          next_action TEXT NOT NULL DEFAULT '',
          waiting_on TEXT NOT NULL DEFAULT '',
          links TEXT NOT NULL DEFAULT '[]',
          position REAL NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          seq INTEGER NOT NULL,
          is_sample INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          deleted_at TEXT,
          created_by TEXT NOT NULL,
          created_by_id TEXT NOT NULL,
          external_key TEXT
        );
        INSERT INTO tasks_new SELECT id, title, notes, area_id, project_id, status, prev_status, priority, due_date, next_action, waiting_on, links, position, rev, seq, is_sample, created_at, updated_at, completed_at, deleted_at, created_by, created_by_id, external_key FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX tasks_status ON tasks(status, position);
        CREATE INDEX tasks_seq ON tasks(seq);
        CREATE INDEX tasks_area ON tasks(area_id);
        CREATE UNIQUE INDEX tasks_external_key ON tasks(external_key) WHERE external_key IS NOT NULL;
      `);
    },
  },
  {
    version: 4,
    name: 'claude threads',
    destructive: false,
    up(db) {
      db.exec(`
        -- Claude Code threads found on this Mac. Read incrementally: offset is how far the file has been read.
        CREATE TABLE claude_threads (
          session_id TEXT PRIMARY KEY,
          file TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          custom_title INTEGER NOT NULL DEFAULT 0,
          cwd TEXT NOT NULL DEFAULT '',
          started_at TEXT,
          last_active_at TEXT,
          is_review INTEGER NOT NULL DEFAULT 0,
          read_offset INTEGER NOT NULL DEFAULT 0,
          user_turns INTEGER NOT NULL DEFAULT 0,
          -- What Claude said last, and its latest "Now on:" and "Decision:" lines. Shown on In progress cards.
          last_reply TEXT NOT NULL DEFAULT '',
          last_reply_at TEXT,
          now_on TEXT NOT NULL DEFAULT '',
          now_on_at TEXT,
          decision TEXT NOT NULL DEFAULT '',
          decision_at TEXT
        );
        -- Many to many: a thread can mention several tasks, a task can be worked on in several threads.
        CREATE TABLE task_threads (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES claude_threads(session_id) ON DELETE CASCADE,
          first_seen_at TEXT NOT NULL,
          last_mentioned_at TEXT NOT NULL,
          mentions INTEGER NOT NULL DEFAULT 1,
          hidden INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (task_id, session_id)
        );
        CREATE INDEX task_threads_session ON task_threads(session_id);
      `);
    },
  },
  {
    version: 5,
    name: 'area modes',
    destructive: false,
    up(db) {
      // Each area is on the work side or the personal side, for the Work / Personal switch.
      db.exec(`
        ALTER TABLE areas ADD COLUMN mode TEXT NOT NULL DEFAULT 'personal' CHECK (mode IN ('work','personal'));
        UPDATE areas SET mode = 'work' WHERE lower(name) = 'work';
      `);
    },
  },
  {
    version: 6,
    name: 'needs you',
    destructive: false,
    up(db) {
      // What only you can do. A note on the task, or a flag on a subtask. Only you can clear either.
      db.exec(`
        ALTER TABLE tasks ADD COLUMN needs_you TEXT NOT NULL DEFAULT '';
        ALTER TABLE subtasks ADD COLUMN needs_you INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 7,
    name: 'needs you context and asks',
    destructive: false,
    up(db) {
      // The why behind each "Needs you" (item is 'task' or a subtask id), and which Claude thread raised it.
      // Asks are your questions about an item, answered by a read-only Claude run on that thread.
      db.exec(`
        CREATE TABLE you_context (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          item TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          session_id TEXT NOT NULL DEFAULT '',
          at TEXT NOT NULL,
          PRIMARY KEY (task_id, item)
        );
        CREATE TABLE asks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          item TEXT NOT NULL,
          question TEXT NOT NULL,
          answer TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('running','done','error')),
          session_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          answered_at TEXT
        );
        CREATE INDEX asks_task ON asks(task_id, created_at);
      `);
    },
  },
  {
    version: 8,
    name: 'subtasks in a set order',
    destructive: false,
    up(db) {
      // 1 when Claude planned the subtasks as a sequence that has to happen in that order. You can unlock it.
      db.exec(`ALTER TABLE tasks ADD COLUMN subtasks_ordered INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    version: 9,
    name: 'what Claude finished',
    destructive: false,
    up(db) {
      // JSON: who finished it and how they knew. Set when an assistant completes a task, cleared once you've seen it.
      db.exec(`ALTER TABLE tasks ADD COLUMN finished_by TEXT;`);
    },
  },
  {
    version: 10,
    name: 'thread linking is opt-in',
    destructive: false,
    up(db) {
      // Reading ~/.claude/projects is now something you turn on. Installs that already linked threads keep it on.
      db.exec(`
        INSERT OR IGNORE INTO settings (key, value)
        SELECT 'threadLinking', 'true' WHERE EXISTS (SELECT 1 FROM claude_threads) OR EXISTS (SELECT 1 FROM task_threads);
      `);
    },
  },
  {
    version: 11,
    name: 'where a task was before In progress',
    destructive: false,
    up(db) {
      // Stop puts a task back where it came from instead of always on Today.
      db.exec(`ALTER TABLE tasks ADD COLUMN started_from TEXT;`);
    },
  },
  {
    version: 12,
    name: 'calmer area colors',
    // It rewrites saved colors, so it only runs with a backup.
    destructive: true,
    up(db) {
      // The area palette moved to eight even hues that skip red, which now means Needs you and Overdue.
      // Each old color becomes the new one in the same place. Colors you picked outside the palette stay.
      const moves: [string, string][] = [
        ['#2563EB', '#526AC3'],
        ['#7C3AED', '#8A57AE'],
        ['#C2410C', '#AC5701'],
        ['#0F766E', '#058379'],
        ['#B45309', '#867003'],
        ['#BE185D', '#AB4A7D'],
        ['#4D7C0F', '#3F842E'],
        ['#0369A1', '#077CA4'],
      ];
      const move = db.prepare('UPDATE areas SET color = ? WHERE upper(color) = ?');
      for (const [from, to] of moves) move.run(to, from);
    },
  },
  {
    version: 13,
    name: 'first-run setup',
    destructive: false,
    up(db) {
      // New installs open on a short setup screen. A database someone already uses counts as set up, so updating
      // never shows it to them: it has tasks, projects or areas the sample seed didn't make, a connection, a
      // suggestion, or any change by anyone but the seed (a sample checked off, a setting changed).
      db.exec(`
        INSERT OR IGNORE INTO settings (key, value)
        SELECT 'setupDone', 'true' WHERE
          EXISTS (SELECT 1 FROM tasks WHERE is_sample = 0)
          OR EXISTS (SELECT 1 FROM projects WHERE is_sample = 0)
          OR EXISTS (SELECT 1 FROM areas WHERE id NOT IN (SELECT entity_id FROM activity WHERE actor_id = 'system:seed' AND entity_type = 'area'))
          OR EXISTS (SELECT 1 FROM activity WHERE actor_id <> 'system:seed')
          OR EXISTS (SELECT 1 FROM clients)
          OR EXISTS (SELECT 1 FROM proposals);
      `);
    },
  },
];

export const LATEST_SCHEMA = migrations[migrations.length - 1].version;
