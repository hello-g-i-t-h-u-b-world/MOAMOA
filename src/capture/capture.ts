// 브라우저 화면 공유(getDisplayMedia)로 게임 창을 받아 프레임을 뽑는다.
import type { Frame } from './recognize';

export class ScreenCapture {
  private video = document.createElement('video');
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private stream: MediaStream | null = null;

  onEnded: (() => void) | null = null;

  get active(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 10 },
      audio: false,
    });
    this.stream.getVideoTracks()[0].addEventListener('ended', () => {
      this.stream = null;
      this.onEnded?.();
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.onEnded?.();
  }

  /** 현재 프레임 (원본 해상도) */
  grab(): (Frame & { image: HTMLCanvasElement }) | null {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!this.stream || !w || !h) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(this.video, 0, 0);
    const img = this.ctx.getImageData(0, 0, w, h);
    return { data: img.data, width: w, height: h, image: this.canvas };
  }
}
