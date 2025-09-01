# After-Effect-Auto-Subtitle
Create subtitles automatically on one-click

This ScriptUI panel for Adobe After Effects automatically generates subtitles for your videos using OpenAI Whisper.
It extracts audio from your composition, transcribes it with Whisper, and places the subtitles directly in After Effects.

**Installation Guide** (Run in bash)
1. Install Python
   1. https://www.python.org/downloads
   2. Download the latest Python 3.x installer.
   3. Run the installer → Check “Add Python to PATH” before installing.

2. Install FFmpeg
   1. Windows:
     https://ffmpeg.org/download.html
     i. Extract the .zip to a folder (e.g., C:\ffmpeg).
     ii. Add FFmpeg to PATH:
       Press Win + S, type Environment Variables, click on "Edit the system environmental variables".
       Environment Variables > Under System variables, find Path, click Edit. Add: "C:\ffmpeg\bin"
   2. macOS:
     Install with Homebrew(https://brew.sh/):
       "brew install ffmpeg"

3. Install Whisper
     "pip install -U openai-whisper"

4. Install PyTorch
   1. https://pytorch.org/get-started/locally/
   2. example:
       If you have an NVIDIA GPU:
           pip3 install torch torchvision --index-url https://download.pytorch.org/whl/cu129
         If not:
           pip3 install torch torchvision

5. Install the After Effects Panel
   1. Download: https://github.com/pushkarexe/After-Effect-Auto-Subtitle/blob/main/AutoSubtitleWhisper.jsx
   2. Locate file in:
       Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\
       or
       /Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/



**Usage**
  1. Open a composition with an audio track.
  2. Open Auto Subtitles panel.
  3. Click Generate Subtitles.
  4. Wait. (Task completion time may vary between computers)

**Troubleshooting**
  1. whisper not found → Python Scripts folder not added to PATH.
  2. ffmpeg not found → FFmpeg not installed or not in PATH.
  3. Slow transcription → Use GPU version of PyTorch + Whisper.
  4. Nothing happens in AE → Ensure the .jsx file is in ScriptUI Panels and you restarted AE.
