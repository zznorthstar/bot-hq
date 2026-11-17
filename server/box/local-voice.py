"""Private stdio speech worker. Audio is held in memory and never sent to a speech API."""
import base64
import concurrent.futures
import io
import json
import os
from pathlib import Path
import sys
import threading

root = Path(os.environ['LOCAL_VOICE_HOME'])
write_lock = threading.Lock()
stt_lock = threading.Lock()
tts_lock = threading.Lock()
stt = None
tts = None


def load_stt():
    global stt
    if stt is None:
        from faster_whisper import WhisperModel
        stt = WhisperModel(str(root / 'models/whisper-base.en'), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
    return stt


def load_tts():
    global tts
    if tts is None:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(str(root / 'models/kokoro-v1.0.int8.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        tts = Kokoro.from_session(session, str(root / 'models/voices-v1.0.bin'))
    return tts


def handle(request):
    try:
        action = request.get('action')
        if action == 'warm':
            with stt_lock:
                load_stt()
            with tts_lock:
                voices = load_tts().get_voices()
            result = {'ready': True, 'voices': voices}
        elif action == 'transcribe':
            audio = base64.b64decode(request['data'], validate=True)
            if len(audio) > 4_000_000 or audio[:4] != b'RIFF' or audio[8:12] != b'WAVE':
                raise ValueError('Send a WAV recording shorter than one minute')
            with stt_lock:
                import numpy as np
                import soundfile as sf
                samples, rate = sf.read(io.BytesIO(audio), dtype='float32')
                if samples.ndim > 1:
                    samples = samples.mean(axis=1)
                if len(samples) / rate > 65:
                    raise ValueError('Voice recordings are limited to one minute')
                if rate != 16000:
                    samples = np.interp(np.arange(int(len(samples) * 16000 / rate)) * rate / 16000, np.arange(len(samples)), samples).astype('float32')
                segments, info = load_stt().transcribe(samples, beam_size=1, language='en', vad_filter=True, condition_on_previous_text=False)
                result = {'text': ' '.join(segment.text.strip() for segment in segments).strip()}
        elif action == 'speak':
            text = request.get('text', '').strip()
            if not text or len(text) > 1200:
                raise ValueError('Speech text must be between 1 and 1200 characters')
            with tts_lock:
                model = load_tts()
                voice = request.get('voice', 'af_heart')
                if voice not in model.get_voices():
                    raise ValueError('Choose an installed voice')
                audio, rate = model.create(text, voice=voice, speed=1.0, lang='en-us')
            import soundfile as sf
            out = io.BytesIO()
            sf.write(out, audio, rate, format='WAV', subtype='PCM_16')
            result = {'audio': {'data': base64.b64encode(out.getvalue()).decode('ascii'), 'mime': 'audio/wav'}}
        else:
            raise ValueError('Unknown speech action')
        response = {'id': request['id'], 'ok': True, **result}
    except Exception as error:
        response = {'id': request.get('id'), 'ok': False, 'error': str(error)[:400]}
    with write_lock:
        sys.stdout.write(json.dumps(response) + '\n')
        sys.stdout.flush()


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    for line in sys.stdin:
        if len(line) > 6_000_000:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        pool.submit(handle, request)
