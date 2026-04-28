# -*- coding: utf-8 -*-
"""
媒体处理模块 - FFmpeg 提取引擎
=====================================
使用本地 FFmpeg 提取视频缩略图和时长

【FFmpeg 路径】
- 位置: SX_DM/__pycache__/ffmpeg/bin/
- 使用相对路径转绝对路径的动态拼接方式
"""

import os
import base64
import tempfile
import logging

logger = logging.getLogger("SX_DM.media_processor")

# 定位 SX_DM 根目录
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 拼接本地 bin 目录路径
FFMPEG_BIN_DIR = os.path.join(BASE_DIR, "__pycache__", "ffmpeg", "bin")
FFMPEG_PATH = os.path.join(FFMPEG_BIN_DIR, "ffmpeg.exe")
FFPROBE_PATH = os.path.join(FFMPEG_BIN_DIR, "ffprobe.exe")

logger.info(f"[MediaProcessor] FFmpeg 路径: {FFMPEG_PATH}")
logger.info(f"[MediaProcessor] FFprobe 路径: {FFPROBE_PATH}")


class MediaProcessor:
    """媒体文件处理引擎（FFmpeg 后端）"""

    @staticmethod
    def get_media_info(file_path: str) -> dict:
        """
        使用本地 FFmpeg 提取视频/音频时长和首帧缩略图
        
        Args:
            file_path: 媒体文件绝对路径
            
        Returns:
            dict: {
                "duration": "mm:ss" 格式时长,
                "thumbnail_base64": Base64 编码的图片（data URI 格式）,
                "type": "video" | "audio" | "unknown"
            }
        """
        result = {
            "duration": "00:00",
            "thumbnail_base64": "",
            "type": "unknown"
        }

        try:
            import ffmpeg
            
            # 1. 获取时长 (使用 ffprobe)
            probe = ffmpeg.probe(file_path, cmd=FFPROBE_PATH)
            format_info = probe.get('format', {})
            duration_seconds = float(format_info.get('duration', 0))

            # 格式化时长
            m = int(duration_seconds // 60)
            s = int(duration_seconds % 60)
            result["duration"] = f"{m:02d}:{s:02d}"
            result["duration_seconds"] = duration_seconds

            # 判断媒体类型
            for stream in probe.get('streams', []):
                if stream.get('codec_type') == 'video':
                    result["type"] = "video"
                    break
                elif stream.get('codec_type') == 'audio':
                    result["type"] = "audio"
                    break

            # 2. 视频截取第一帧并转为 Base64
            if result["type"] == "video":
                with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as temp_img:
                    temp_img_path = temp_img.name

                (
                    ffmpeg
                    .input(file_path, ss=0)
                    .output(
                        temp_img_path,
                        vframes=1,
                        format='image2',
                        vcodec='mjpeg',
                        loglevel='error'
                    )
                    .overwrite_output()
                    .run(cmd=FFMPEG_PATH, capture_stdout=True, capture_stderr=True)
                )

                # 读取临时图片并转码为 Base64
                with open(temp_img_path, "rb") as img_file:
                    encoded_string = base64.b64encode(img_file.read()).decode('utf-8')
                    result["thumbnail_base64"] = f"data:image/jpeg;base64,{encoded_string}"

                # 清理临时文件
                os.remove(temp_img_path)
                logger.info(f"[MediaProcessor] 视频处理完成: {file_path}, 时长: {result['duration']}")

        except ImportError:
            logger.warning("[MediaProcessor] ffmpeg-python 未安装，将使用 OpenCV 降级方案")
            result = MediaProcessor._fallback_with_cv2(file_path)
        except ffmpeg.Error as e:
            logger.error(f"[MediaProcessor] FFmpeg 处理出错: {e.stderr.decode('utf8', errors='ignore')}")
            # 降级到 OpenCV
            result = MediaProcessor._fallback_with_cv2(file_path)
        except Exception as e:
            logger.error(f"[MediaProcessor] 获取媒体信息失败: {e}")
            result = MediaProcessor._fallback_with_cv2(file_path)

        return result

    @staticmethod
    def _fallback_with_cv2(file_path: str) -> dict:
        """
        OpenCV 降级方案（当 FFmpeg 不可用时）
        仅支持视频缩略图，音频返回空结果
        """
        result = {
            "duration": "00:00",
            "thumbnail_base64": "",
            "type": "unknown"
        }

        try:
            import cv2

            cap = cv2.VideoCapture(file_path)

            if not cap.isOpened():
                logger.warning(f"[MediaProcessor] OpenCV 无法打开文件: {file_path}")
                return result

            result["type"] = "video"

            # 获取时长
            fps = cap.get(cv2.CAP_PROP_FPS)
            frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)

            if fps > 0:
                duration_seconds = frame_count / fps
            else:
                duration_seconds = 0

            m = int(duration_seconds // 60)
            s = int(duration_seconds % 60)
            result["duration"] = f"{m:02d}:{s:02d}"

            # 截取第一帧
            ret, frame = cap.read()
            if ret:
                # 缩放到合适大小
                height, width = frame.shape[:2]
                max_size = 300
                if max(height, width) > max_size:
                    scale = max_size / max(height, width)
                    frame = cv2.resize(frame, (int(width * scale), int(height * scale)))

                # 编码为 JPEG
                _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                encoded = base64.b64encode(buffer).decode('utf-8')
                result["thumbnail_base64"] = f"data:image/jpeg;base64,{encoded}"

            cap.release()
            logger.info(f"[MediaProcessor] OpenCV 降级方案处理完成: {file_path}")

        except ImportError:
            logger.warning("[MediaProcessor] OpenCV 也不可用")
        except Exception as e:
            logger.error(f"[MediaProcessor] OpenCV 处理失败: {e}")

        return result
