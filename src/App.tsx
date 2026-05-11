import { GoogleGenAI, Modality } from '@google/genai';
import { Film, FileText, Play, Languages, Loader2, Music, Download, Settings, Square } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const TTS_VOICES = [
  { id: 'Puck', label: 'Male: Puck' },
  { id: 'Charon', label: 'Male: Charon' },
  { id: 'Kore', label: 'Female: Kore' },
  { id: 'Fenrir', label: 'Male: Fenrir' },
  { id: 'Aoede', label: 'Female: Aoede' }
];

const VOXCPM_VOICES = [
  { id: 'alloy', label: 'Neutral: Alloy' },
  { id: 'echo', label: 'Male: Echo' },
  { id: 'fable', label: 'British Male: Fable' },
  { id: 'onyx', label: 'Deep Male: Onyx' },
  { id: 'nova', label: 'Female: Nova' },
  { id: 'shimmer', label: 'Clear Female: Shimmer' }
];

interface Subtitle {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  audioUrl?: string; // object URL to the generated WAV
  isGenerating?: boolean;
  voice: string;
  engine?: string;
}

// Convert "00:00:01,000" to seconds
function parseTime(timeStr: string): number {
  const parts = timeStr.trim().split(',');
  const hms = parts[0].split(':');
  const ms = parts[1] ? Number(parts[1]) : 0;
  return Number(hms[0]) * 3600 + Number(hms[1]) * 60 + Number(hms[2]) + ms / 1000;
}

// Parse standard SRT format
function parseSRT(srt: string): Subtitle[] {
  const normalized = srt.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const subtitles: Subtitle[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length >= 3) {
      const id = parseInt(lines[0], 10);
      const timeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
      if (timeMatch) {
        const startTime = parseTime(timeMatch[1]);
        const endTime = parseTime(timeMatch[2]);
        const text = lines.slice(2).join(' ').trim();
        if (text) {
          subtitles.push({ id, startTime, endTime, text, voice: 'default' });
        }
      }
    }
  }
  return subtitles;
}

// Convert PCM16 to WAV
function encodeWAV(samples: Int16Array, sampleRate: number = 24000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }

  return new Blob([view], { type: 'audio/wav' });
}

export default function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  // Sync state refs
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeSubtitleIdRef = useRef<number | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<number | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [ttsEngine, setTtsEngine] = useState<'gemini' | 'google-free' | 'voxcpm'>('google-free');

  const [referenceAudioFile, setReferenceAudioFile] = useState<File | null>(null);
  const [referenceAudioBase64, setReferenceAudioBase64] = useState<string | null>(null);

  const handleReferenceAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setReferenceAudioFile(file);
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1];
        setReferenceAudioBase64(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  // Load video file
  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setErrorMsg(null);
    }
  };

  // Load and parse SRT
  const handleSRTUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        const parsed = parseSRT(text);
        setSubtitles(parsed);
        setErrorMsg(null);
      };
      reader.readAsText(file);
    }
  };

  const [showSettings, setShowSettings] = useState(false);
  const [geminiKey, setGeminiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [voxcpmUrl, setVoxcpmUrl] = useState(() => localStorage.getItem('voxcpm_url') || 'http://127.0.0.1:8808');

  const [defaultGeminiVoice, setDefaultGeminiVoice] = useState(() => localStorage.getItem('default_gemini_voice') || 'Puck');
  const [defaultVoxCPMVoice, setDefaultVoxCPMVoice] = useState(() => localStorage.getItem('default_voxcpm_voice') || 'alloy');

  const saveSettings = () => {
    localStorage.setItem('gemini_api_key', geminiKey);
    localStorage.setItem('voxcpm_url', voxcpmUrl);
    localStorage.setItem('default_gemini_voice', defaultGeminiVoice);
    localStorage.setItem('default_voxcpm_voice', defaultVoxCPMVoice);
    setShowSettings(false);
  };

  // Generate audio for a single subtitle
  const generateSubtitleAudio = async (sub: Subtitle): Promise<string | null> => {
    try {
      const engineToUse = (!sub.engine || sub.engine === 'default') ? ttsEngine : sub.engine;
      let voiceToUse = sub.voice;
      if (!voiceToUse || voiceToUse === 'default') {
        if (engineToUse === 'gemini') voiceToUse = defaultGeminiVoice;
        else if (engineToUse === 'voxcpm') voiceToUse = defaultVoxCPMVoice;
        else voiceToUse = 'km'; // fallback
      }

      if (engineToUse === 'voxcpm') {
        const baseURL = (localStorage.getItem('voxcpm_url') || 'http://127.0.0.1:8808')
          .replace(/\/$/, '');

        let refWavPayload = null;
        if (referenceAudioBase64 && referenceAudioFile) {
          const mimeType = referenceAudioFile.type || 'audio/wav';
          const dataUri = `data:${mimeType};base64,${referenceAudioBase64}`;
          refWavPayload = {
            name: referenceAudioFile.name,
            data: dataUri,
            path: dataUri,
            meta: { _type: "gradio.FileData" }
          };
        }

        const promptText = voiceToUse && voiceToUse !== 'default' ? voiceToUse : '';

        const payload = {
          data: [
            sub.text,          // text
            "",                // control_instruction
            refWavPayload,     // reference_wav
            !!promptText,      // use_prompt_text
            promptText,        // prompt_text
            2.0,               // cfg_value
            false,             // normalize
            false,             // denoise
            10                 // dit_steps
          ]
        };

        let startRes;
        try {
          startRes = await fetch(`${baseURL}/gradio_api/call/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify(payload)
          });
        } catch (err: any) {
          if (err.name === 'TypeError' && err.message.includes('Failed to fetch')) {
            throw new Error(`Failed to connect to VoxCPM at ${baseURL}. If you are seeing a "Failed to fetch" or "Mixed Content" error, it's because this app is served over HTTPS but your VoxCPM server is HTTP. Please use ngrok (e.g. \`ngrok http 8808\`) to get an HTTPS URL for your local server, or allow insecure content in your browser settings.`);
          }
          throw err;
        }

        if (!startRes.ok) {
          throw new Error(`VoxCPM start error: ${startRes.status} - ${await startRes.text()}`);
        }

        const startData = await startRes.json();
        const eventId = startData.event_id;

        const resultRes = await fetch(
          `${baseURL}/gradio_api/call/generate/${eventId}`,
          {
            headers: {
              'ngrok-skip-browser-warning': 'true'
            }
          }
        );

        if (!resultRes.ok) {
          throw new Error(`VoxCPM result error: ${resultRes.status} - ${await resultRes.text()}`);
        }

        const resultText = await resultRes.text();

        const match = resultText.match(/data:\s*(\[.*\])/s);
        if (!match) {
          throw new Error(`VoxCPM returned no audio: ${resultText}`);
        }

        const parsed = JSON.parse(match[1]);
        const audioPath = parsed?.[0]?.url || parsed?.[0]?.path;

        if (!audioPath) {
          throw new Error(`VoxCPM audio URL not found: ${resultText}`);
        }

        const audioUrl = audioPath.startsWith('http')
          ? audioPath
          : `${baseURL}${audioPath}`;

        const audioRes = await fetch(audioUrl, {
          headers: {
            'ngrok-skip-browser-warning': 'true'
          }
        });
        const blob = await audioRes.blob();

        return URL.createObjectURL(blob);
      }

      if (engineToUse === 'google-free') {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sub.text, lang: 'km' })
        });
        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to fetch free TTS');
        }
        const data = await res.json();
        
        if (!data.results || data.results.length === 0) {
          throw new Error('No audio returned');
        }

        // Fix: googleTTS returns base64 MP3 chunks. We encode them to a single MP3 blob.
        const base64Chunks = data.results.map((r: any) => r.base64);
        const audioData = base64Chunks.join('');
        const binary = atob(audioData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'audio/mp3' });
        return URL.createObjectURL(blob);
      }

      // Create a prompt that encourages dramatic, expressive Khmer
      const prompt = `Read the following Khmer text vividly and passionately, with deeply emotional and dramatic tone resembling a Chinese short video drama: ${sub.text}`;
      
      const localGeminiKey = localStorage.getItem('gemini_api_key');
      const activeAi = (localGeminiKey && localGeminiKey.trim() !== '') ? new GoogleGenAI({ apiKey: localGeminiKey.trim() }) : ai;
      
      const response = await activeAi.models.generateContent({
        model: 'gemini-3.1-flash-tts-preview',
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voiceToUse },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('No audio data received');
      }

      // Decode base64 PCM16 into WAV blob
      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const pcm16 = new Int16Array(bytes.buffer);
      const wavBlob = encodeWAV(pcm16, 24000); // TTS endpoint sample rate is 24kHz

      return URL.createObjectURL(wavBlob);
    } catch (err: any) {
      console.error('Failed to generate audio for subtitle', sub.id, err);
      let errMsg = err.message || String(err);
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
         errMsg = "Rate limit or quota exceeded: " + errMsg;
      }
      setErrorMsg(errMsg);
      return null;
    }
  };

  const handleVoiceChange = (id: number, voice: string) => {
    setSubtitles((prev) => prev.map((s) => (s.id === id ? { ...s, voice, audioUrl: undefined } : s)));
  };

  const handleEngineChange = (id: number, engine: string) => {
    setSubtitles((prev) => prev.map((s) => (s.id === id ? { ...s, engine, voice: 'default', audioUrl: undefined } : s)));
  };

  const handlePreviewAudio = (e: React.MouseEvent, sub: Subtitle) => {
    e.stopPropagation();
    if (!sub.audioUrl) return;

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.onended = null;
    }

    if (previewingId === sub.id) {
      setPreviewingId(null);
      return;
    }

    const audio = new Audio(sub.audioUrl);
    previewAudioRef.current = audio;
    setPreviewingId(sub.id);

    audio.onended = () => {
      setPreviewingId(null);
    };
    
    audio.play().catch(err => {
      console.error('Failed to play preview', err);
      setPreviewingId(null);
    });
  };

  // Generate audio for a single subtitle from UI
  const handleGenerateSingle = async (e: React.MouseEvent, sub: Subtitle) => {
    e.stopPropagation();
    setErrorMsg(null);
    setSubtitles((prev) => prev.map((s) => (s.id === sub.id ? { ...s, isGenerating: true } : s)));
    const url = await generateSubtitleAudio(sub);
    setSubtitles((prev) =>
      prev.map((s) => (s.id === sub.id ? { ...s, isGenerating: false, audioUrl: url || undefined } : s))
    );
    if (url) {
       // Stop any existing preview
       if (previewAudioRef.current) {
         previewAudioRef.current.pause();
       }
       const audio = new Audio(url);
       previewAudioRef.current = audio;
       setPreviewingId(sub.id);
       audio.onended = () => setPreviewingId(null);
       audio.play().catch(e => {
         console.error('Auto-play failed', e);
         setPreviewingId(null);
       });
    }
  };

  // Generate all sequentially
  const handleGenerateAll = async () => {
    setErrorMsg(null);
    setIsGeneratingAll(true);
    for (let i = 0; i < subtitles.length; i++) {
      if (subtitles[i].audioUrl) continue; // skip already generated

      // Optimistic update for loading state
      setSubtitles((prev) =>
        prev.map((s, idx) => (idx === i ? { ...s, isGenerating: true } : s))
      );

      const url = await generateSubtitleAudio(subtitles[i]);
      
      // Update with result
      setSubtitles((prev) =>
        prev.map((s, idx) =>
          idx === i ? { ...s, isGenerating: false, audioUrl: url || undefined } : s
        )
      );

      if (!url) {
        // Break the loop if there was an error (e.g., 429 quota exceeded)
        break;
      }

      // Auto-play the audio snippet we just generated, and wait for it to finish!
      if (previewAudioRef.current) previewAudioRef.current.pause();
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      setPreviewingId(subtitles[i].id);
        
      await new Promise<void>((resolve) => {
         audio.onended = () => {
            setPreviewingId(null);
            resolve();
         };
         audio.play().catch((e) => {
            console.error('Auto-play failed', e);
            setPreviewingId(null);
            resolve();
         });
      });

      // Add a delay to avoid rate limiting (Gemini Free Tier is 15 RPM, so 4.1s per request to be safe)
      if (i < subtitles.length - 1) {
        await new Promise((res) => setTimeout(res, 4100));
      }
    }
    setIsGeneratingAll(false);
  };

  const [isExportingAudio, setIsExportingAudio] = useState(false);

  const handleExportAudioTrack = async () => {
    if (subtitles.length === 0) return;
    const totalDuration = Math.max(...subtitles.map(s => s.endTime));
    if (totalDuration <= 0) return;

    setIsExportingAudio(true);
    setErrorMsg(null);

    try {
      const OfflineCtxClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
      const sampleRate = 44100;
      const offlineCtx = new OfflineCtxClass(1, Math.ceil(sampleRate * totalDuration), sampleRate);
      
      // Load all valid audios
      for (const sub of subtitles) {
        if (!sub.audioUrl) continue;
        try {
          const resp = await fetch(sub.audioUrl);
          const arrayBuffer = await resp.arrayBuffer();
          const audioBuffer = await offlineCtx.decodeAudioData(arrayBuffer);
          const source = offlineCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineCtx.destination);
          source.start(sub.startTime);
        } catch (e) {
          console.warn(`Failed to process audio for subtitle ${sub.id}`, e);
        }
      }

      const renderedBuffer = await offlineCtx.startRendering();
      const float32Array = renderedBuffer.getChannelData(0);
      const int16Array = new Int16Array(float32Array.length);
      for (let i = 0; i < float32Array.length; i++) {
        let s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      const wavBlob = encodeWAV(int16Array, renderedBuffer.sampleRate);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'synthesized_track.wav';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to export audio track:', err);
      setErrorMsg("Failed to export audio track.");
    } finally {
      setIsExportingAudio(false);
    }
  };

  // Synchronize audio playback with video
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let syncFrame: number;

    const loop = () => {
      const time = video.currentTime;
      setCurrentTime(time);

      // Mute the video's original audio since we're replacing it with TTS? 
      // User might want to keep original audio as background, we will just sync our TTS on top.
      
      // Find active subtitle
      const activeContent = subtitles.find((s) => time >= s.startTime && time <= s.endTime);

      if (activeContent) {
        if (activeSubtitleIdRef.current !== activeContent.id) {
          // Changed subtitle boundary
          if (currentAudioRef.current) {
            currentAudioRef.current.pause();
          }

          if (activeContent.audioUrl) {
            const audio = new Audio(activeContent.audioUrl);
            audio.currentTime = time - activeContent.startTime; // sync offset
            // Match playback rate
            audio.playbackRate = video.playbackRate;
            if (!video.paused) {
              audio.play().catch(console.error);
            }
            currentAudioRef.current = audio;
          } else {
            currentAudioRef.current = null;
          }
          activeSubtitleIdRef.current = activeContent.id;
        } else {
          // Currently in the same subtitle window
          if (currentAudioRef.current) {
            // Keep playback state synced
            if (video.paused && !currentAudioRef.current.paused) {
              currentAudioRef.current.pause();
            } else if (!video.paused && currentAudioRef.current.paused) {
              currentAudioRef.current.play().catch(console.error);
            }
            
            // Keep playback rate synced
            if (currentAudioRef.current.playbackRate !== video.playbackRate) {
              currentAudioRef.current.playbackRate = video.playbackRate;
            }

            // Correct drift if it goes off by > 150ms
            const expectedTime = time - activeContent.startTime;
            if (Math.abs(currentAudioRef.current.currentTime - expectedTime) > 0.15) {
              currentAudioRef.current.currentTime = expectedTime;
            }
          }
        }
      } else {
        // Outside of any subtitle
        if (activeSubtitleIdRef.current !== null) {
          if (currentAudioRef.current) {
            currentAudioRef.current.pause();
            currentAudioRef.current = null;
          }
          activeSubtitleIdRef.current = null;
        }
      }

      syncFrame = requestAnimationFrame(loop);
    };

    const onSeeked = () => {
      // Force resync after seeking
      if (currentAudioRef.current && activeSubtitleIdRef.current !== null) {
        const sub = subtitles.find((s) => s.id === activeSubtitleIdRef.current);
        if (sub) {
          currentAudioRef.current.currentTime = video.currentTime - sub.startTime;
        }
      }
    };

    video.addEventListener('seeked', onSeeked);
    syncFrame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(syncFrame);
      video.removeEventListener('seeked', onSeeked);
      if (currentAudioRef.current) {
         currentAudioRef.current.pause();
         currentAudioRef.current = null;
      }
    };
  }, [subtitles]);

  // Clean up object URLs
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      subtitles.forEach((s) => {
        if (s.audioUrl) URL.revokeObjectURL(s.audioUrl);
      });
    };
  }, []);

  return (
    <div className="w-full h-screen bg-[#020617] text-slate-200 font-sans overflow-hidden flex flex-col">
      <datalist id="voxcpm-voices">
        {VOXCPM_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
      </datalist>

      {/* Top Header */}
      <header className="h-14 shrink-0 border-b border-slate-800 flex items-center justify-between px-6 bg-slate-900/50 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-amber-500 rounded flex items-center justify-center text-slate-950 font-bold">
            K
          </div>
          <span className="font-semibold tracking-tight text-lg">KhmerDub <span className="text-amber-500">Studio</span></span>
        </div>
        <div className="flex items-center gap-4">
          <button onClick={() => setShowSettings(true)} className="p-2 hover:bg-slate-800 rounded-md text-slate-400 hover:text-white transition-colors">
            <Settings className="w-5 h-5" />
          </button>
          <button className="px-4 py-1.5 bg-slate-800 rounded-md text-sm font-medium border border-slate-700 hidden md:block">រក្សាទុក</button>
          <button 
            disabled={isExportingAudio || subtitles.length === 0}
            onClick={handleExportAudioTrack}
            className="px-4 py-1.5 bg-amber-500 text-slate-950 rounded-md text-sm font-bold shadow-lg shadow-amber-500/20 disabled:opacity-50"
          >
            {isExportingAudio ? 'កំពុងនាំចេញ...' : 'នាំចេញសំឡេង'}
          </button>
          <button className="px-4 py-1.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 rounded-md text-sm font-bold shadow-lg shadow-amber-500/5 hidden md:block">នាំចេញវីដេអូ</button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel: Upload Controls */}
        <aside className="w-72 border-r border-slate-800 p-5 flex flex-col gap-6 bg-[#020617] overflow-y-auto hidden md:flex shrink-0">
          <div>
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">ឯកសារ (Files)</h3>
            <div className="space-y-4">
              {/* Video Upload */}
              <div className="relative border border-dashed border-slate-700 hover:border-amber-500 hover:bg-slate-800/50 transition-colors rounded p-4 flex flex-col items-center justify-center group cursor-pointer h-24">
                <Film className="w-5 h-5 text-slate-500 mb-2 group-hover:text-amber-400" />
                <span className="text-xs font-medium text-slate-400 group-hover:text-slate-200 text-center">
                  {videoFile ? videoFile.name : 'Upload MP4/WebM'}
                </span>
                <input 
                  type="file" 
                  accept="video/mp4,video/webm" 
                  onChange={handleVideoUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </div>

              {/* SRT Upload */}
              <div className="relative border border-dashed border-slate-700 hover:border-amber-500 hover:bg-slate-800/50 transition-colors rounded p-4 flex flex-col items-center justify-center group cursor-pointer h-24">
                <FileText className="w-5 h-5 text-slate-500 mb-2 group-hover:text-amber-400" />
                <span className="text-xs font-medium text-slate-400 group-hover:text-slate-200 text-center">
                  {subtitles.length > 0 ? `${subtitles.length} lines loaded` : 'Upload Khmer SRT'}
                </span>
                <input 
                  type="file" 
                  accept=".srt" 
                  onChange={handleSRTUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </div>

              {/* Reference Audio Upload */}
              <div className="relative border border-dashed border-slate-700 hover:border-amber-500 hover:bg-slate-800/50 transition-colors rounded p-4 flex flex-col items-center justify-center group cursor-pointer h-24">
                <Music className="w-5 h-5 text-slate-500 mb-2 group-hover:text-amber-400" />
                <span className="text-xs font-medium text-slate-400 group-hover:text-slate-200 text-center">
                  {referenceAudioFile ? referenceAudioFile.name : 'Upload Reference Audio'}
                </span>
                <input 
                  type="file" 
                  accept="audio/*" 
                  onChange={handleReferenceAudioUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </div>
            </div>
          </div>
          
          <div className="mt-auto p-4 bg-slate-900/80 border border-slate-800 rounded-xl space-y-4 text-center">
              {subtitles.length > 0 && (
                <button
                  onClick={handleGenerateAll}
                  disabled={isGeneratingAll}
                  className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold py-2 px-4 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-[13px] shadow-lg shadow-amber-500/20"
                >
                  {isGeneratingAll ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    'Generate Audio'
                  )}
                </button>
              )}
          </div>
        </aside>

        {/* Center: Video Player Area */}
        <main className="flex-1 bg-black/40 flex flex-col relative overflow-hidden">
          <div className="flex-1 flex items-center justify-center p-4 md:p-8 relative overflow-y-auto">
            <div className="w-full max-w-4xl aspect-video bg-slate-900 rounded-lg shadow-2xl relative overflow-hidden ring-1 ring-slate-800 flex items-center justify-center">
              {videoUrl ? (
                <video 
                  ref={videoRef}
                  src={videoUrl} 
                  controls 
                  crossOrigin="anonymous"
                  className="w-full h-full bg-black"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center flex-col gap-4 bg-gradient-to-t from-slate-950/60 to-transparent text-slate-600">
                  <Play className="w-12 h-12 opacity-30" />
                  <span className="text-sm font-medium">Waiting for video...</span>
                </div>
              )}
            </div>
          </div>
          
          {/* Mobile upload controls */}
          <div className="md:hidden p-4 border-t border-slate-800 bg-slate-900/50 flex flex-col gap-2 shrink-0">
             <div className="flex gap-2">
               <label className="flex-1 text-center py-2 px-4 bg-slate-800 border border-slate-700 rounded text-xs font-medium text-slate-300 cursor-pointer">
                 {videoFile ? 'Change Video' : 'Upload Video'}
                 <input type="file" accept="video/mp4,video/webm" onChange={handleVideoUpload} className="hidden" />
               </label>
               <label className="flex-1 text-center py-2 px-4 bg-slate-800 border border-slate-700 rounded text-xs font-medium text-slate-300 cursor-pointer">
                 {subtitles.length > 0 ? 'Change SRT' : 'Upload SRT'}
                 <input type="file" accept=".srt" onChange={handleSRTUpload} className="hidden" />
               </label>
             </div>
             <div className="flex gap-2">
               <label className="flex-1 text-center py-2 px-4 bg-slate-800 border border-slate-700 rounded text-xs font-medium text-slate-300 cursor-pointer">
                 {referenceAudioFile ? 'Change Ref Audio' : 'Upload Ref Audio'}
                 <input type="file" accept="audio/*" onChange={handleReferenceAudioUpload} className="hidden" />
               </label>
             </div>
             {subtitles.length > 0 && (
                <button
                  onClick={handleGenerateAll}
                  disabled={isGeneratingAll}
                  className="w-full py-2 bg-amber-500 text-slate-950 rounded text-xs font-bold disabled:opacity-50"
               >
                 {isGeneratingAll ? 'Generating...' : 'Generate All Audio'}
               </button>
             )}
             <div className="mt-4 flex flex-col gap-2">
               <label className="text-xs text-slate-500 uppercase font-bold">TTS Engine</label>
               <div className="flex flex-wrap bg-slate-800 rounded p-1 gap-1">
                 <button 
                  onClick={() => setTtsEngine('google-free')}
                  className={`flex-1 min-w-[70px] text-[10px] py-1.5 rounded transition bg-transparent ${ttsEngine === 'google-free' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
                 >Google Free</button>
                 <button 
                  onClick={() => setTtsEngine('voxcpm')}
                  className={`flex-1 min-w-[70px] text-[10px] py-1.5 rounded transition ${ttsEngine === 'voxcpm' ? 'bg-purple-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}
                 >VoxCPM</button>
                 <button 
                  onClick={() => setTtsEngine('gemini')}
                  className={`flex-1 min-w-[70px] text-[10px] py-1.5 rounded transition ${ttsEngine === 'gemini' ? 'bg-amber-600 text-white font-medium' : 'text-slate-400 hover:text-white'}`}
                 >Gemini</button>
               </div>
               {ttsEngine === 'google-free' && (
                 <p className="text-[10px] text-slate-500">Free, basic text-to-speech. Unlimited attempts.</p>
               )}
               {ttsEngine === 'voxcpm' && (
                 <p className="text-[10px] text-purple-400/80">Uses local VoxCPM Gradio endpoint for generation.</p>
               )}
               {ttsEngine === 'gemini' && (
                 <p className="text-[10px] text-amber-500/70">High-quality dramatic voice. Limited by quota (15 RPM free).</p>
               )}
             </div>
          </div>
        </main>

        {/* Right Panel: Subtitle List */}
        <aside className="w-80 border-l border-slate-800 bg-slate-900/30 flex flex-col shrink-0 max-w-full">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
            <h3 className="text-xs font-bold text-slate-500 uppercase">អត្ថបទ SRT (Subtitles)</h3>
            <button className="p-1 hover:bg-slate-800 rounded">
               <Music className="w-4 h-4 text-slate-500" />
            </button>
          </div>
          
          {errorMsg && (
            <div className="p-3 m-3 bg-red-500/10 border border-red-500/50 rounded text-red-400 text-xs text-center break-words">
              {errorMsg}
            </div>
          )}

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {subtitles.length > 0 ? (
               <div className="flex flex-col">
                 {subtitles.map((sub) => {
                  const isActive = currentTime >= sub.startTime && currentTime <= sub.endTime;
                  
                  return (
                    <div 
                      key={sub.id} 
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.currentTime = sub.startTime;
                          videoRef.current.play().catch(console.error);
                        }
                      }}
                      className={`p-3 border-b border-slate-800/50 transition-colors cursor-pointer ${isActive ? 'bg-slate-800/30 border-l-2 border-l-amber-500' : 'hover:bg-slate-800/20'}`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className={`text-[10px] ${isActive ? 'text-amber-500' : 'text-slate-500'}`}>
                          {new Date(sub.startTime * 1000).toISOString().substr(11, 8)}
                        </span>
                        
                        <div className="flex items-center">
                          {sub.isGenerating ? (
                            <span className="text-[10px] text-amber-500 flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin"/>
                            </span>
                          ) : sub.audioUrl ? (
                             <div className="flex items-center gap-2">
                              {isActive && <span className="text-[10px] text-emerald-400">Active</span>}
                              <button 
                                onClick={(e) => handlePreviewAudio(e, sub)}
                                className="text-amber-500 hover:text-amber-400 transition-colors"
                                title="Preview Audio"
                              >
                                {previewingId === sub.id ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                              </button>
                              <a href={sub.audioUrl} download={`sub_${sub.id}.wav`} className="text-slate-500 hover:text-white transition-colors" title="Download WAV" onClick={(e) => e.stopPropagation()}>
                                <Download className="w-4 h-4" />
                              </a>
                            </div>
                          ) : (
                            <button
                                onClick={(e) => handleGenerateSingle(e, sub)}
                                disabled={isGeneratingAll}
                                className="text-[10px] text-slate-400 hover:text-amber-500 transition-colors px-2 py-1 border border-slate-700 hover:border-amber-500/50 rounded bg-slate-800 disabled:opacity-50"
                            >
                                Generate
                            </button>
                          )}
                        </div>
                      </div>
                      <p className={`text-sm leading-relaxed mb-2 ${isActive ? 'text-slate-200 font-medium' : 'text-slate-400'}`}>
                        {sub.text}
                      </p>
                      <div className="flex items-center justify-end gap-2">
                        <select
                          value={sub.engine || 'default'}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => handleEngineChange(sub.id, e.target.value)}
                          className="bg-slate-900 text-[10px] text-slate-400 border border-slate-700 rounded px-2 py-1 outline-none hover:border-slate-500/50 transition-colors"
                        >
                          <option value="default">Global Engine</option>
                          <option value="gemini">Gemini</option>
                          <option value="voxcpm">VoxCPM</option>
                          <option value="google-free">Google Free</option>
                        </select>
                        {(() => {
                          const eng = (!sub.engine || sub.engine === 'default') ? ttsEngine : sub.engine;
                          return eng === 'gemini' ? (
                          <select 
                            value={sub.voice} 
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => handleVoiceChange(sub.id, e.target.value)}
                            className="bg-slate-900 text-[10px] text-slate-400 border border-slate-700 rounded px-2 py-1 outline-none hover:border-amber-500/50 transition-colors"
                          >
                            <option value="default">Global Default</option>
                            {TTS_VOICES.map((v) => (
                              <option key={v.id} value={v.id}>{v.label}</option>
                            ))}
                          </select>
                        ) : eng === 'voxcpm' ? (
                          <input 
                            type="text"
                            list="voxcpm-voices"
                            value={sub.voice === 'default' ? '' : sub.voice}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => handleVoiceChange(sub.id, e.target.value || 'default')}
                            placeholder={`Prompt Text (Default: ${defaultVoxCPMVoice})`}
                            className="w-32 bg-slate-900 text-[10px] text-purple-400/80 border border-slate-700 rounded px-2 py-1 outline-none hover:border-purple-500/50 transition-colors"
                          />
                        ) : (
                          <span className="text-[10px] text-slate-600 italic">Default Voice</span>
                        );
                        })()}
                      </div>
                    </div>
                  );
                })}
               </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-600 p-4">
                <FileText className="w-10 h-10 mb-3 opacity-20" />
                <p className="text-sm">Upload an SRT file to load subtitles and generate dramatic Khmer audio.</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-md p-6 shadow-2xl">
            <h2 className="text-xl font-semibold text-white mb-6">API Configuration</h2>
            
            <div className="space-y-4 mb-6 max-h-[65vh] overflow-y-auto pr-2 custom-scrollbar">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5 flex justify-between">
                  <span>VoxCPM Server URL & Voice</span>
                  <a href="https://support.google.com/chrome/answer/99020" target="_blank" rel="noreferrer" className="text-[10px] text-purple-400 hover:text-purple-300 underline">Mixed Content Fix</a>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={voxcpmUrl}
                    onChange={(e) => setVoxcpmUrl(e.target.value)}
                    placeholder="https://your-ngrok/v1/audio/speech"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 transition-all font-mono"
                  />
                  <input
                    type="text"
                    list="voxcpm-voices"
                    value={defaultVoxCPMVoice}
                    onChange={(e) => setDefaultVoxCPMVoice(e.target.value)}
                    placeholder="Prompt Text"
                    className="w-24 bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-purple-500 transition-all"
                  />
                </div>
                <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                  Full VoxCPM Gradio endpoint URL. Needs to be accessible from this app.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5 flex justify-between">
                  <span>Gemini API Key & Default Voice</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)}
                    placeholder="AIza..."
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-md px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
                  />
                  <select 
                    value={defaultGeminiVoice} 
                    onChange={(e) => setDefaultGeminiVoice(e.target.value)}
                    className="w-32 bg-slate-950 border border-slate-800 rounded-md px-2 py-2 text-sm text-white focus:outline-none focus:border-amber-500 transition-all"
                  >
                    {TTS_VOICES.map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
                  </select>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800">
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 bg-transparent hover:bg-slate-800 text-slate-300 rounded-md text-sm font-medium transition-colors"
               >
                Cancel
              </button>
              <button
                onClick={saveSettings}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-md text-sm font-bold shadow-lg shadow-amber-500/20 transition-all"
               >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: #334155;
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background-color: #475569;
        }
      `}</style>
    </div>
  );
}

