import type { ClockPersistence } from '../modules/store/types.js';
import type { Clock } from './runtime.js';

export interface WorldClockOptions {
  /** 系统时间来源，测试可注入 */
  wall?: () => number;
  /** 高水位写入的最小间隔，避免每次读时钟都落盘 */
  saveEveryMs?: number;
  /** 检测到时间被调到过去时的回调（日志/诊断） */
  onRegression?: (behindMs: number) => void;
}

/**
 * 世界时钟：只增不减的服务端权威时间。
 * - 正常情况下等于系统时间；
 * - 系统时间被调到过去（或重启后比上次记录的最晚时间还早）时，世界时间停在高水位，
 *   待系统时间追平后继续——因此回拨不会让同一段时间被重复计入收益，也不会跳过突破冷却；
 * - 高水位持久化，重启后继续生效。
 * 系统时间被调快无法与「休眠/离线很久」区分，受离线规则（上限与效率）约束。
 */
export class WorldClock implements Clock {
  private high: number;
  private lastSaved: number;
  private readonly wall: () => number;
  private readonly saveEveryMs: number;
  private readonly onRegression?: (behindMs: number) => void;

  constructor(
    private readonly persistence: ClockPersistence,
    opts: WorldClockOptions = {},
  ) {
    this.wall = opts.wall ?? Date.now;
    this.saveEveryMs = opts.saveEveryMs ?? 60_000;
    this.onRegression = opts.onRegression;
    const persisted = persistence.load() ?? 0;
    this.high = Math.max(persisted, this.wall());
    this.lastSaved = persisted;
    if (this.high > this.wall()) this.onRegression?.(this.high - this.wall());
    this.flush(true);
  }

  now(): number {
    const w = this.wall();
    if (w >= this.high) {
      this.high = w;
      this.flush(false);
    } else {
      this.onRegression?.(this.high - w);
    }
    return this.high;
  }

  /** 世界时间落后于系统时间以外的情况：系统时间比世界时间早多少（正常为 0） */
  behindMs(): number {
    return Math.max(0, this.high - this.wall());
  }

  /** 立即持久化高水位（关闭服务前调用） */
  flush(force = true): void {
    if (force || this.high - this.lastSaved >= this.saveEveryMs) {
      this.persistence.save(this.high);
      this.lastSaved = this.high;
    }
  }
}
