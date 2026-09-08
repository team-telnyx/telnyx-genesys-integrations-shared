const DEFAULT_FRAME_DURATION_MS = 20;

export class RealtimeAudioPacer {
  constructor({
    sendFrame,
    canSend = () => true,
    frameDurationMs = DEFAULT_FRAME_DURATION_MS,
    initialDelayMs = frameDurationMs,
    catchUpFrameDurationMs = frameDurationMs,
    catchUpThresholdFrames = Number.MAX_SAFE_INTEGER,
    maxQueueFrames = 1500,
    overflow = "throw",
    onDrop = () => {},
    onCatchUp = () => {},
    onError = () => {},
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = (timer) => clearTimeout(timer),
  } = {}) {
    if (typeof sendFrame !== "function") {
      throw new TypeError("sendFrame must be a function");
    }
    if (!Number.isInteger(frameDurationMs) || frameDurationMs <= 0) {
      throw new TypeError("frameDurationMs must be a positive integer");
    }
    if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
      throw new TypeError("initialDelayMs must be a non-negative integer");
    }
    if (
      !Number.isInteger(catchUpFrameDurationMs) ||
      catchUpFrameDurationMs <= 0 ||
      catchUpFrameDurationMs > frameDurationMs
    ) {
      throw new TypeError(
        "catchUpFrameDurationMs must be a positive integer no greater than frameDurationMs"
      );
    }
    if (!Number.isInteger(catchUpThresholdFrames) || catchUpThresholdFrames < 0) {
      throw new TypeError("catchUpThresholdFrames must be a non-negative integer");
    }
    if (!Number.isInteger(maxQueueFrames) || maxQueueFrames <= 0) {
      throw new TypeError("maxQueueFrames must be a positive integer");
    }
    if (!["throw", "drop-oldest"].includes(overflow)) {
      throw new TypeError("overflow must be throw or drop-oldest");
    }

    this.sendFrame = sendFrame;
    this.canSend = canSend;
    this.frameDurationMs = frameDurationMs;
    this.initialDelayMs = initialDelayMs;
    this.catchUpFrameDurationMs = catchUpFrameDurationMs;
    this.catchUpThresholdFrames = catchUpThresholdFrames;
    this.maxQueueFrames = maxQueueFrames;
    this.overflow = overflow;
    this.onDrop = onDrop;
    this.onCatchUp = onCatchUp;
    this.onError = onError;
    this.schedule = schedule;
    this.cancel = cancel;
    this.queue = [];
    this.timer = null;
    this.running = false;
    this.streamStarted = false;
    this.scheduledCatchUp = false;
    this.droppedFrames = 0;
    this.catchUpFrames = 0;
    this.peakPendingFrames = 0;
  }

  get pendingFrames() {
    return this.queue.length;
  }

  enqueue(frame) {
    const value = Buffer.isBuffer(frame) ? Buffer.from(frame) : Buffer.from(frame || []);
    if (!value.length) return false;

    if (this.queue.length >= this.maxQueueFrames) {
      if (this.overflow === "throw") {
        throw new RangeError("Realtime audio pacing queue is full");
      }
      const dropped = this.queue.shift();
      this.droppedFrames += 1;
      this.onDrop(dropped);
    }

    this.queue.push(value);
    this.peakPendingFrames = Math.max(this.peakPendingFrames, this.queue.length);
    this.scheduleNext();
    return true;
  }

  enqueueMany(frames) {
    let enqueued = 0;
    for (const frame of frames) {
      if (this.enqueue(frame)) enqueued += 1;
    }
    return enqueued;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  clear() {
    const cleared = this.queue.length;
    this.queue.length = 0;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.streamStarted = false;
    this.scheduledCatchUp = false;
    return cleared;
  }

  stop() {
    this.running = false;
    return this.clear();
  }

  scheduleNext() {
    if (!this.running || this.timer !== null || !this.queue.length) return;
    const catchUp =
      this.streamStarted &&
      this.queue.length > this.catchUpThresholdFrames &&
      this.catchUpFrameDurationMs < this.frameDurationMs;
    const delay = !this.streamStarted
      ? this.initialDelayMs
      : catchUp
        ? this.catchUpFrameDurationMs
        : this.frameDurationMs;
    this.scheduledCatchUp = catchUp;
    this.timer = this.schedule(() => this.tick(), delay);
  }

  tick() {
    this.timer = null;
    const catchUp = this.scheduledCatchUp;
    this.scheduledCatchUp = false;
    if (!this.running || !this.queue.length) return;

    try {
      // Once the first attempt has run, backpressure retries use the regular
      // frame interval. This prevents a zero-delay retry loop when the socket
      // is temporarily not writable.
      this.streamStarted = true;
      if (!this.canSend()) {
        this.scheduleNext();
        return;
      }

      const frame = this.queue.shift();
      this.sendFrame(frame);
      if (catchUp) {
        this.catchUpFrames += 1;
        this.onCatchUp(frame);
      }
      if (!this.queue.length) this.streamStarted = false;
    } catch (error) {
      this.running = false;
      this.queue.length = 0;
      this.onError(error);
      return;
    }

    // Schedule from the completion of this send. A delayed event-loop tick must
    // never be followed by a catch-up burst of multiple real-time audio frames.
    this.scheduleNext();
  }
}
