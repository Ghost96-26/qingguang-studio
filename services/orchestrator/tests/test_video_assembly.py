"""Real CPU-only encoder verification using synthetic fixtures, never user media or GPU."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from services.orchestrator.workbench.video_assembly import assemble_video, assembly_command
from services.orchestrator.workbench.media_tools import inspect_media


class VideoAssemblyTests(unittest.TestCase):
    def test_exact_duration_picture_geometry_audio_and_score(self):
        config = Path(__file__).resolve().parents[3] / "config" / "gateway.json"
        ffmpeg = Path(json.loads(config.read_text(encoding="utf-8-sig"))["ffmpeg_executable"])
        if not ffmpeg.is_file(): self.skipTest("Configured ffmpeg unavailable")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); clip = root / "source.mp4"; score = root / "score.wav"
            subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=5.2", "-f", "lavfi", "-i", "sine=frequency=200:duration=5.2", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(clip)], check=True, timeout=30, capture_output=True, creationflags=flags)
            subprocess.run([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=100:duration=10", str(score)], check=True, timeout=30, capture_output=True, creationflags=flags)
            params = {"clips":[{"path":str(clip),"seconds":4},{"path":str(clip),"seconds":4}],"width":1344,"height":768,"fps":24,"score_path":str(score)}
            output = assemble_video({"id":"review-test","params":params}, {"artifact_root":str(root),"ffmpeg_executable":str(ffmpeg)}, lambda *args: None, lambda: False)
            metadata = inspect_media(output["outputs"][0], ffmpeg)
            self.assertAlmostEqual(metadata["duration_seconds"], 8, delta=1/24)
            self.assertEqual((metadata["width"], metadata["height"], metadata["frame_rate"]),(1344,768,24))
            self.assertEqual(metadata["sample_rate"],48000)
            self.assertEqual(metadata["channels"],2)
            self.assertEqual(output["profile"]["crf"],14)
            with self.assertRaisesRegex(ValueError,"短于计划"):
                assembly_command({**params,"clips":[{"path":str(clip),"seconds":10}]}, ffmpeg, root / "rejected.mp4")


if __name__ == "__main__": unittest.main()
