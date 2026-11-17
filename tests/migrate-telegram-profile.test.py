from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('telegram_migration', Path(__file__).parents[1] / 'server/box/migrate-telegram-profile.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
SCHEMA = '''
CREATE TABLE system_prompts(hash TEXT PRIMARY KEY,prompt TEXT);
CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,system_prompt_hash TEXT,system_prompt TEXT,session_key TEXT,profile_name TEXT,transport_profile TEXT,origin_json TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT REFERENCES sessions(id),role TEXT,content TEXT);
CREATE TABLE session_model_usage(session_id TEXT REFERENCES sessions(id),model TEXT);
CREATE TABLE gateway_routing(scope TEXT,session_key TEXT,entry_json TEXT,updated_at REAL);
'''

class Migration(unittest.TestCase):
    def test_history_is_filtered_rekeyed_and_never_overwrites_existing_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.db'
            target = root / 'profile/state.db'
            target.parent.mkdir()
            for file in [source, target]:
                with closing(sqlite3.connect(file)) as connection, connection:
                    connection.executescript(SCHEMA)
            with closing(sqlite3.connect(source)) as connection, connection:
                connection.execute('INSERT INTO system_prompts VALUES(?,?)', ('old-prompt', 'Old cached prompt'))
                for session_id, platform in [('tg', 'telegram'), ('discord', 'discord')]:
                    connection.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)', (session_id, platform, None, 1, 'old-prompt', 'Old cached prompt', 'agent:main:' + platform + ':dm:123', None, None, json.dumps({'platform': platform})))
                    connection.execute('INSERT INTO messages(session_id,role,content) VALUES(?,?,?)', (session_id, 'user', platform + ' conversation'))
                entry = {'session_id': 'tg', 'platform': 'telegram', 'origin': {'platform': 'telegram'}, 'prompt_pin': {'old': 'context'}, 'resume_pending': True}
                connection.execute('INSERT INTO gateway_routing VALUES(?,?,?,?)', (directory, 'agent:main:telegram:dm:123', json.dumps(entry), 1))
            before = source.read_bytes()
            self.assertEqual(migration.copy_history(source, target, 'raat'), {'sessions': 1, 'messages': 1, 'routing_entries': 1})
            self.assertEqual(source.read_bytes(), before)
            with closing(sqlite3.connect(target)) as connection, connection:
                row = connection.execute('SELECT source,profile_name,transport_profile,session_key,system_prompt_hash FROM sessions').fetchone()
                self.assertEqual(row, ('telegram', 'raat', 'raat', 'agent:raat:telegram:dm:123', None))
                self.assertEqual(connection.execute('SELECT content FROM messages').fetchone()[0], 'telegram conversation')
                entry = json.loads(connection.execute('SELECT entry_json FROM gateway_routing').fetchone()[0])
                self.assertFalse(entry['resume_pending'])
                self.assertIsNone(entry['prompt_pin'])
                self.assertEqual(entry['origin']['profile'], 'raat')
                self.assertFalse(connection.execute('PRAGMA foreign_key_check').fetchall())
            with self.assertRaisesRegex(RuntimeError, 'already has sessions'):
                migration.copy_history(source, target, 'raat')

if __name__ == '__main__':
    unittest.main()
