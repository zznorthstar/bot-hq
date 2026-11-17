"""Copy Telegram history into a new native Hermes profile; never write the source DB.

Run with Hermes Python after gracefully stopping the old Telegram gateway:
  python -I migrate-telegram-profile.py <source-home> <target-home> <profile>
"""
from pathlib import Path
import json
import os
import re
import sqlite3
import sys


def copy_history(source_file, target_file, profile):
    source = sqlite3.connect(Path(source_file).resolve().as_uri() + '?mode=ro', uri=True)
    source.row_factory = sqlite3.Row
    target = sqlite3.connect(target_file)
    target.row_factory = sqlite3.Row
    target.execute('PRAGMA foreign_keys=ON')
    try:
        if target.execute('SELECT count(*) FROM sessions').fetchone()[0]:
            raise RuntimeError('The target profile already has sessions; refusing to replace them')
        sessions = source.execute("WITH RECURSIVE family(id) AS (SELECT id FROM sessions WHERE source='telegram' UNION SELECT s.id FROM sessions s JOIN family f ON s.parent_session_id=f.id) SELECT * FROM sessions WHERE id IN family ORDER BY started_at").fetchall()
        ids = {row['id'] for row in sessions}
        if not ids:
            raise RuntimeError('No Telegram history was found')
        rewrite = lambda key: re.sub(r'^agent:main:', 'agent:' + profile + ':', key) if key else key
        def insert(table, rows):
            columns = {row[1] for row in target.execute('PRAGMA table_info(' + table + ')')}
            for row in rows:
                values = {key: value for key, value in dict(row).items() if key in columns}
                names = list(values)
                target.execute('INSERT INTO ' + table + '(' + ','.join('"' + key + '"' for key in names) + ') VALUES(' + ','.join('?' for _ in names) + ')', [values[key] for key in names])
        marks = ','.join('?' for _ in ids)
        parameters = list(ids)
        messages = source.execute('SELECT * FROM messages WHERE session_id IN (' + marks + ') ORDER BY id', parameters).fetchall()
        with target:
            hashes = {row['system_prompt_hash'] for row in sessions if row['system_prompt_hash']}
            if hashes:
                insert('system_prompts', source.execute('SELECT * FROM system_prompts WHERE hash IN (' + ','.join('?' for _ in hashes) + ')', list(hashes)).fetchall())
            for original in sessions:
                row = dict(original)
                row['session_key'] = rewrite(row['session_key'])
                row['profile_name'] = profile
                row['transport_profile'] = profile
                # Rebuild the next turn's prompt for Raat's own soul, tools and home.
                row['system_prompt'] = None
                row['system_prompt_hash'] = None
                if row.get('origin_json'):
                    origin = json.loads(row['origin_json'])
                    origin['profile'] = profile
                    row['origin_json'] = json.dumps(origin)
                insert('sessions', [row])
            insert('messages', messages)
            insert('session_model_usage', source.execute('SELECT * FROM session_model_usage WHERE session_id IN (' + marks + ')', parameters).fetchall())
            entries = {}
            for row in source.execute('SELECT * FROM gateway_routing'):
                entry = json.loads(row['entry_json'])
                if entry.get('session_id') not in ids or entry.get('platform') != 'telegram':
                    continue
                key = rewrite(row['session_key'])
                entry['session_key'] = key
                entry['transport_profile'] = profile
                entry['origin'] = {**(entry.get('origin') or {}), 'profile': profile}
                # The gateway was drained; never replay an old in-flight turn after migration.
                entry.update(active_turn_started_at=None, active_turn_token=None, resume_pending=False, prompt_pin=None)
                target.execute('INSERT INTO gateway_routing(scope,session_key,entry_json,updated_at) VALUES(?,?,?,?)', (str(Path(target_file).parent.joinpath('sessions').resolve()), key, json.dumps(entry), row['updated_at']))
                entries[key] = entry
            if target.execute('PRAGMA foreign_key_check').fetchone():
                raise RuntimeError('Imported history failed its foreign-key check')
        Path(target_file).parent.joinpath('sessions').mkdir(parents=True, exist_ok=True)
        index = Path(target_file).parent / 'sessions/sessions.json'
        index.write_text(json.dumps(entries, indent=2))
        index.chmod(0o600)
        return {'sessions': len(sessions), 'messages': len(messages), 'routing_entries': len(entries)}
    finally:
        target.close()
        source.close()


if __name__ == '__main__':
    source, target = map(lambda value: Path(value).expanduser().resolve(), sys.argv[1:3])
    profile = sys.argv[3]
    if not re.fullmatch(r'[a-z][a-z0-9_-]{0,39}', profile) or target != source / 'profiles' / profile:
        raise ValueError('The target must be a new named profile under the source Hermes home')
    os.environ['HERMES_HOME'] = str(target)
    sys.path.insert(0, os.environ.get('HERMES_SOURCE_DIR', str(source / 'hermes-agent')))
    __import__('hermes_bootstrap')
    from hermes_state import SessionDB
    state = SessionDB(db_path=target / 'state.db')
    state.close()
    result = copy_history(source / 'state.db', target / 'state.db', profile)
    (target / 'state.db').chmod(0o600)
    marker = target / '.telegram-history-import.json'
    marker.write_text(json.dumps(result))
    marker.chmod(0o600)
    print(json.dumps(result))
