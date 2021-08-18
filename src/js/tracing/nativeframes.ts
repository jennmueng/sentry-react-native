import { Span, Transaction } from "@sentry/tracing";
import { Event, EventProcessor, Measurements } from "@sentry/types";
import { logger, timestampInSeconds } from "@sentry/utils";

import { NativeFramesResponse } from "../definitions";
import { NATIVE } from "../wrapper";
import { instrumentChildSpanFinish } from "./utils";

type FramesMeasurements = Record<'frames_total' | 'frames_slow' | 'frames_frozen', { value: number }>;

const MARGIN_OF_ERROR_SECONDS = 0.05;

/**
 * Instrumentation to add native slow/frozen frames measurements onto transactions.
 */
export class NativeFramesInstrumentation {
  private _finishFrames: Map<
    string,
    { timestamp: number; nativeFrames: NativeFramesResponse | null }
  > = new Map();
  private _framesListeners: Map<string, () => void> = new Map();
  private _lastSpanFinishFrames?: {
    timestamp: number;
    nativeFrames: NativeFramesResponse;
  };

  public constructor(
    addGlobalEventProcessor: (e: EventProcessor) => void,
    doesExist: () => boolean
  ) {
    logger.log(
      "[ReactNativeTracing] Native frames instrumentation initialized."
    );

    addGlobalEventProcessor((event) => {
      if (doesExist()) {
        return this._processEvent(event);
      }

      return event;
    });
  }

  /**
   * To be called when a transaction is started
   */
  public onTransactionStart(transaction: Transaction): void {
    void NATIVE.fetchNativeFrames().then((framesMetrics) => {
      if (framesMetrics) {
        transaction.setData("__startFrames", framesMetrics);
      }
    });

    instrumentChildSpanFinish(transaction, this._onSpanFinish.bind(this));
  }

  /**
   * To be called when a transaction is finished
   */
  public onTransactionFinish(transaction: Transaction): void {
    void this._fetchFramesForTransaction(transaction);
  }

  /**
   * Called on a span finish to fetch native frames to support transactions with trimEnd.
   */
  private _onSpanFinish(_: Span, endTimestamp?: number): void {
    if (!endTimestamp) {
      const timestamp = timestampInSeconds();

      void NATIVE.fetchNativeFrames().then((nativeFrames) => {
        if (nativeFrames) {
          this._lastSpanFinishFrames = {
            timestamp,
            nativeFrames,
          };
        }
      });
    }
  }

  /**
   * Returns the computed frames measurements and awaits for them if they are not ready yet.
   */
  private async _getFramesMeasurements(
    traceId: string,
    finalEndTimestamp: number,
    startFrames: NativeFramesResponse
  ): Promise<FramesMeasurements | null> {
    if (this._finishFrames.has(traceId)) {
      return this._prepareMeasurements(traceId, finalEndTimestamp, startFrames);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._framesListeners.delete(traceId);

        resolve(null);
      }, 2000);

      this._framesListeners.set(traceId, () => {
        resolve(
          this._prepareMeasurements(traceId, finalEndTimestamp, startFrames)
        );

        clearTimeout(timeout);
        this._framesListeners.delete(traceId);
      });
    });
  }

  /**
   * Returns the computed frames measurements given ready data
   */
  private _prepareMeasurements(
    traceId: string,
    finalEndTimestamp: number, // The actual transaction finish time.
    startFrames: NativeFramesResponse
  ): FramesMeasurements | null {
    let finalFinishFrames: NativeFramesResponse | undefined;

    const finish = this._finishFrames.get(traceId);
    if (
      finish &&
      finish.nativeFrames &&
      // Must be in the margin of error of the actual transaction finish time (finalEndTimestamp)
      Math.abs(finish.timestamp - finalEndTimestamp) < MARGIN_OF_ERROR_SECONDS
    ) {
      finalFinishFrames = finish.nativeFrames;
    } else if (
      this._lastSpanFinishFrames &&
      Math.abs(this._lastSpanFinishFrames.timestamp - finalEndTimestamp) <
        MARGIN_OF_ERROR_SECONDS
    ) {
      // Fallback to the last span finish if it is within the margin of error of the actual finish timestamp.
      // This should be the case for trimEnd.
      finalFinishFrames = this._lastSpanFinishFrames.nativeFrames;
    } else {
      return null;
    }

    const measurements = {
      frames_total: {
        value: finalFinishFrames.totalFrames - startFrames.totalFrames,
      },
      frames_frozen: {
        value: finalFinishFrames.frozenFrames - startFrames.frozenFrames,
      },
      frames_slow: {
        value: finalFinishFrames.slowFrames - startFrames.slowFrames,
      },
    };

    return measurements;
  }

  /**
   * Fetch finish frames for a transaction at the current time. Calls any awaiting listeners.
   */
  private async _fetchFramesForTransaction(
    transaction: Transaction
  ): Promise<void> {
    const startFrames = transaction.data.__startFrames as
      | NativeFramesResponse
      | undefined;

    // This timestamp marks when the finish frames were retrieved. It should be pretty close to the transaction finish.
    const timestamp = timestampInSeconds();
    let finishFrames: NativeFramesResponse | null = null;
    if (startFrames) {
      finishFrames = await NATIVE.fetchNativeFrames();
    }

    this._finishFrames.set(transaction.traceId, {
      nativeFrames: finishFrames,
      timestamp,
    });

    this._framesListeners.get(transaction.traceId)?.();

    setTimeout(() => this._cancelFinishFrames(transaction), 2000);
  }

  /**
   * On a finish frames failure, we cancel the await.
   */
  private _cancelFinishFrames(transaction: Transaction): void {
    if (this._finishFrames.has(transaction.traceId)) {
      this._finishFrames.delete(transaction.traceId);

      logger.log(
        `[NativeFrames] Native frames timed out for ${transaction.op} transaction ${transaction.name}. Not adding native frames measurements.`
      );
    }
  }

  /**
   * Adds frames measurements to an event. Called from a valid event processor.
   * Awaits for finish frames if needed.
   */
  private async _processEvent(event: Event): Promise<Event> {
    if (
      event.type === "transaction" &&
      event.transaction &&
      event.contexts &&
      event.contexts.trace
    ) {
      const traceContext = event.contexts.trace as {
        data?: { [key: string]: unknown };
        trace_id: string;
        name?: string;
        op?: string;
      };

      const traceId = traceContext.trace_id;

      if (traceId && traceContext.data?.__startFrames && event.timestamp) {
        const measurements = await this._getFramesMeasurements(
          traceId,
          event.timestamp,
          traceContext.data.__startFrames as NativeFramesResponse
        );

        if (!measurements) {
          logger.log(
            `[NativeFrames] Could not fetch native frames for ${traceContext.op} transaction ${event.transaction}. Not adding native frames measurements.`
          );
        } else {
          logger.log(
            `[Measurements] Adding measurements to ${
              traceContext.op
            } transaction ${event.transaction}: ${JSON.stringify(
              measurements,
              undefined,
              2
            )}`
          );

          event.measurements = {
            ...(event.measurements ?? {}),
            ...measurements,
          };

          this._finishFrames.delete(traceId);
        }

        delete traceContext.data.__startFrames;
      }
    }

    return event;
  }
}
