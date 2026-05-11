import express from "express";
import { createServer as createViteServer } from "vite";
import * as googleTTS from "google-tts-api";
import path from "path";
import OpenAI from "openai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API to generate TTS via OpenAI
  app.post("/api/tts/openai", async (req, res) => {
    try {
      const { text, voice = "alloy", model = "tts-1", apiKey } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }

      let openaiClient: OpenAI;
      if (apiKey && apiKey.trim() !== '') {
        openaiClient = new OpenAI({ apiKey: apiKey.trim() });
      } else if (process.env.OPENAI_API_KEY) {
        openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      } else {
        return res.status(400).json({ error: "OpenAI API Key is not configured. Please enter your API key in the Settings." });
      }

      const mp3 = await openaiClient.audio.speech.create({
        model: model as 'tts-1' | 'tts-1-hd',
        voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
        input: text,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      const base64 = buffer.toString("base64");

      res.json({ result: base64 });
    } catch (error: any) {
      console.error("OpenAI TTS error:", error);
      res.status(500).json({ error: error.message || String(error) });
    }
  });

  // API to generate free TTS via Google Translate API
  app.post("/api/tts", async (req, res) => {
    try {
      const { text, lang = "km" } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }

      // Convert the text to audio base64 parts using google-tts-api
      // It handles texts longer than 200 characters natively by splitting
      const results = await googleTTS.getAllAudioBase64(text, {
        lang: lang,
        slow: false,
        host: "https://translate.google.com",
        timeout: 10000,
      });

      // return array of base64 chunks
      res.json({ results });
    } catch (error: any) {
      console.error("TTS generation error:", error);
      res.status(500).json({ error: error.message || String(error) });
    }
  });

  // API to generate TTS via Google Cloud Text-to-Speech
  app.post("/api/tts/gcloud", async (req, res) => {
    try {
      const { text, voice = "km-KH-Standard-A", apiKey } = req.body;
      if (!text || !apiKey) {
        return res.status(400).json({ error: "Text and Google Cloud API key are required" });
      }
      const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: "km-KH", name: voice },
          audioConfig: { audioEncoding: "MP3" }
        })
      });
      if (!response.ok) {
         const err = await response.json().catch(() => ({}));
         throw new Error(err.error?.message || response.statusText);
      }
      const data = await response.json();
      res.json({ result: data.audioContent });
    } catch (err: any) {
      console.error("Google Cloud TTS error:", err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // API to generate TTS via Azure Cognitive Services
  app.post("/api/tts/azure", async (req, res) => {
    try {
      const { text, voice = "km-KH-PisethNeural", apiKey, region = "southeastasia" } = req.body;
      if (!text || !apiKey || !region) {
        return res.status(400).json({ error: "Text, Azure API key, and region are required" });
      }
      
      const ssml = `<speak version='1.0' xml:lang='km-KH'><voice xml:lang='km-KH' name='${voice}'>${text}</voice></speak>`;
      
      const response = await fetch(`https://${region.trim()}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST',
        headers: { 
          'Ocp-Apim-Subscription-Key': apiKey.trim(),
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3'
        },
        body: ssml
      });
      if (!response.ok) {
         let errText = '';
         try { errText = await response.text(); } catch (e) {}
         throw new Error(errText || response.statusText);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.json({ result: buffer.toString('base64') });
    } catch (err: any) {
      console.error("Azure TTS error:", err);
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
