CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lead','contributor','viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  yjs_state TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'contributor',
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS canvas_nodes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT,
  position JSONB NOT NULL,
  acl JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_deleted BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS canvas_events (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  canvas_node_id UUID REFERENCES canvas_nodes(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  author_id UUID REFERENCES users(id) ON DELETE SET NULL,
  intent_label TEXT NOT NULL CHECK (intent_label IN ('action_item','decision','open_question','reference')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_invites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lead','contributor','viewer')),
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  token TEXT UNIQUE NOT NULL,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (room_id, email)
);

CREATE TABLE IF NOT EXISTS conflict_events (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  node_id UUID REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  user_a UUID REFERENCES users(id) ON DELETE SET NULL,
  user_b UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  node_id UUID,
  attempted_action TEXT NOT NULL,
  denial_reason TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS yjs_state TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT false;

-- Email field for password reset
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

-- Password reset / OTP fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;

-- Jira-like task tracking extensions
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'todo'
  CHECK (status IN ('todo','in_progress','done'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE tasks SET title = COALESCE(title, content) WHERE title IS NULL;
