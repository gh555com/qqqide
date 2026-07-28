# Copyright (C) 2025-2026 Sichuan Dream Technology Co., Ltd. All Rights Reserved.

# 文件名: miniaudio_nonblocking_v15.py
#
# v1.2 - 综合优化版
# - 结合 V2 的健壮错误处理 (加载和播放)
# - 结合 V1 的正确 cleanup 逻辑 (避免 V2 的 bug)

import miniaudio
import time
import os
import random
import threading
from concurrent.futures import ThreadPoolExecutor

class NonBlockingAudioEngine:
    """
    非阻塞音频播放引擎，基于q2.py的v15逻辑和q1.py的多线程实现
    支持无延迟、多音效同步播放
    v1.3 — 新增音量控制: master_volume (0.0-1.0) 控制总音量
    """

    def __init__(self, asset_folder="assets", master_volume=0.25):
        print("非阻塞音频引擎 (NonBlockingAudioEngine) 正在初始化...")
        self.asset_folder = asset_folder
        self.master_volume = float(master_volume)  # 总音量 0.0-1.0，默认 0.25 (25%)

        # 分类音量乘数: main=水滴音效, q=打枪音效, z=清空音效
        self._volume_mult = {'main': 1.0, 'q': 0.05, 'z': 1.0}

        # 音频格式设置 (从q2.py的v15逻辑)
        self.REQUESTED_FORMAT = miniaudio.SampleFormat.SIGNED16
        self.REQUESTED_CHANNELS = 2
        self.REQUESTED_RATE = 44100

        # 线程池设置 (从q1.py的多线程实现)
        self.executor = ThreadPoolExecutor(max_workers=32)  # 支持最多32个并发音效

        # 加载音效文件
        self.main_sounds = []  # 主音效列表
        self.q_sounds = []     # q系列音效列表
        self.z_sounds = []     # z系列音效列表

        self.last_played_main = -1
        self.last_played_q = -1
        self.last_played_z = -1

        # 加载所有音效文件
        self._load_sound_files()
        print(f"非阻塞音频引擎初始化完毕，共加载 {len(self.main_sounds)} 个主音效，{len(self.q_sounds)} 个q音效，{len(self.z_sounds)} 个z音效，音量={self.master_volume:.0%}")

    # --- (取自 V2：更健壮的加载) ---
    def _load_sound_files(self):
        """加载所有音效文件"""
        try:
            # 检查资源文件夹是否存在
            if not os.path.isdir(self.asset_folder):
                raise FileNotFoundError(f"错误：找不到资源文件夹 '{self.asset_folder}'")

            # 加载主音效 (1.wav, 2.wav, ...)
            for i in range(1, 9):  # 假设有8个主音效
                try:
                    wav_file = os.path.join(self.asset_folder, f"{i}.wav")
                    mp3_file = os.path.join(self.asset_folder, f"{i}.mp3")

                    if os.path.exists(wav_file):
                        self.main_sounds.append(wav_file)
                    elif os.path.exists(mp3_file):
                        self.main_sounds.append(mp3_file)
                except Exception as e:
                    print(f"加载主音效文件 {i} 时出错: {e}")

            # 加载q系列音效 (q1.wav, q2.wav, ...)
            for i in range(1, 10):  # 假设有9个q音效
                try:
                    wav_file = os.path.join(self.asset_folder, f"q{i}.wav")
                    mp3_file = os.path.join(self.asset_folder, f"q{i}.mp3")

                    if os.path.exists(wav_file):
                        self.q_sounds.append(wav_file)
                    elif os.path.exists(mp3_file):
                        self.q_sounds.append(mp3_file)
                except Exception as e:
                    print(f"加载q音效文件 q{i} 时出错: {e}")

            # 加载z系列音效 (z1.wav, z2.wav, ...)
            for i in range(1, 7):  # 假设有6个z音效
                try:
                    wav_file = os.path.join(self.asset_folder, f"z{i}.wav")
                    mp3_file = os.path.join(self.asset_folder, f"z{i}.mp3")

                    if os.path.exists(wav_file):
                        self.z_sounds.append(wav_file)
                    elif os.path.exists(mp3_file):
                        self.z_sounds.append(mp3_file)
                except Exception as e:
                    print(f"加载z音效文件 z{i} 时出错: {e}")

        except Exception as e:
            print(f"加载音效文件时出错: {e}")
            # 即使加载失败，也继续运行，只是没有音效
    # --- (V2 逻辑结束) ---

    def _get_random_sound(self, sound_list, last_played_index):
        """从音效列表中获取一个随机的音效文件，确保与上一个不同"""
        if not sound_list:
            return None

        if len(sound_list) == 1:
            return sound_list[0]

        new_index = last_played_index
        while new_index == last_played_index:
            new_index = random.randint(0, len(sound_list) - 1)

        return sound_list[new_index]

    # --- (v1.5: stream_file/stream_raw_pcm_memory + PlaybackDevice, 兼容 miniaudio 1.61) ---
    def _play_sound_worker(self, file_path, volume=1.0):
        """音频播放工作线程。vol>=0.999→stream_file 快速路径; 否则 decode→gain→stream_raw_pcm_memory。"""
        device = None
        vol = max(0.0, min(1.0, float(volume)))
        try:
            if not os.path.exists(file_path):
                return
            info = miniaudio.get_file_info(file_path)
            if info.duration <= 0:
                return
            if vol >= 0.999:
                stream = miniaudio.stream_file(file_path)
                device = miniaudio.PlaybackDevice()
            else:
                decoded = miniaudio.decode_file(file_path)
                samples = decoded.samples
                for i in range(len(samples)):
                    samples[i] = int(samples[i] * vol)
                pcm_bytes = samples.tobytes()
                sw = miniaudio.width_from_format(decoded.sample_format)
                stream = miniaudio.stream_raw_pcm_memory(pcm_bytes,
                    nchannels=decoded.nchannels, sample_width=sw, frames_to_read=1024)
                device = miniaudio.PlaybackDevice(output_format=decoded.sample_format,
                    nchannels=decoded.nchannels, sample_rate=decoded.sample_rate)
            device.start(stream)
            time.sleep(info.duration + 0.15)
        except Exception as e:
            print(f"【!!】 音频播放失败 {file_path}: {e}")
        finally:
            if device:
                try: device.stop()
                except Exception: pass
                try: device.close()
                except Exception: pass
    # --- (v1.5 逻辑结束) ---

    def set_volume(self, vol):
        """设置总音量 0.0-1.0"""
        self.master_volume = max(0.0, min(1.0, float(vol)))

    def set_volume_mult(self, category, mult):
        """设置分类音量乘数: 'main'/'q'/'z'"""
        if category in self._volume_mult:
            self._volume_mult[category] = max(0.0, min(1.0, float(mult)))

    def play_random_sound(self):
        """播放随机主音效"""
        sound = self._get_random_sound(self.main_sounds, self.last_played_main)
        if sound:
            self.last_played_main = self.main_sounds.index(sound)
            self.executor.submit(self._play_sound_worker, sound, self.master_volume * self._volume_mult['main'])

    def play_q_sound(self):
        """播放随机q系列音效（打枪音效 — 音量减半后受总音量控制）"""
        sound = self._get_random_sound(self.q_sounds, self.last_played_q)
        if sound:
            self.last_played_q = self.q_sounds.index(sound)
            self.executor.submit(self._play_sound_worker, sound, self.master_volume * self._volume_mult['q'])

    def play_z_sound(self):
        """播放随机z系列音效"""
        sound = self._get_random_sound(self.z_sounds, self.last_played_z)
        if sound:
            self.last_played_z = self.z_sounds.index(sound)
            self.executor.submit(self._play_sound_worker, sound, self.master_volume * self._volume_mult['z'])

    def play_sound_file(self, file_path):
        """播放指定的音频文件"""
        if os.path.exists(file_path):
            self.executor.submit(self._play_sound_worker, file_path, self.master_volume)

    def play_sound_index(self, sound_type, index):
        """
        播放指定类型的特定索引音效
        sound_type: 'main', 'q', 'z'
        index: 音效索引（从1开始）
        """
        vol = self.master_volume * self._volume_mult.get(sound_type, 1.0)
        if sound_type == 'main':
            if 1 <= index <= len(self.main_sounds):
                self.executor.submit(self._play_sound_worker, self.main_sounds[index-1], vol)
        elif sound_type == 'q':
            if 1 <= index <= len(self.q_sounds):
                self.executor.submit(self._play_sound_worker, self.q_sounds[index-1], vol)
        elif sound_type == 'z':
            if 1 <= index <= len(self.z_sounds):
                self.executor.submit(self._play_sound_worker, self.z_sounds[index-1], vol)

    # --- (取自 V1：正确的清理) ---
    def cleanup(self):
        """清理资源"""
        print("正在关闭非阻塞音频引擎...")
        if self.executor:
            self.executor.shutdown(wait=True)
        print("非阻塞音频引擎已关闭。")
    # --- (V1 逻辑结束) ---


# 用于独立测试此模块
if __name__ == "__main__":
    print("="*50)
    print("正在独立测试 NonBlockingAudioEngine 模块 (v1.2 综合版)...")

    try:
        engine = NonBlockingAudioEngine(asset_folder="assets")

        print("\n测试播放随机主音效...")
        engine.play_random_sound()
        time.sleep(1)  # 等待1秒

        print("\n测试播放q音效...")
        engine.play_q_sound()
        time.sleep(1)  # 等待1秒

        print("\n测试播放z音效...")
        engine.play_z_sound()
        time.sleep(1)  # 等待1秒

        print("\n测试同时播放多个音效...")
        engine.play_random_sound()
        engine.play_q_sound()
        engine.play_z_sound()

        print("\n等待所有音效播放完成...")
        time.sleep(5)  # 等待所有音效播放完成

        engine.cleanup()
        print("\nNonBlockingAudioEngine 模块测试完毕。")

    except FileNotFoundError as e:
        print(f"\n测试失败：{e}")
        print("请确保 'assets' 文件夹和音效文件存在于正确的位置。")
    except Exception as e:
        print(f"\n测试期间发生意外错误: {e}")
