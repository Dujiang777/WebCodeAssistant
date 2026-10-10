package com.webcode.assistant.agent;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TurnCancellationTest {

    private final TurnCancellation cancellation = new TurnCancellation();

    @Test
    void newTurnMakesPreviousGenerationStale() {
        long first = cancellation.begin(7);
        long second = cancellation.begin(7);
        assertThat(second).isGreaterThan(first);
        assertThat(cancellation.isStale(7, first)).isTrue();
        assertThat(cancellation.isCanceled(7, first)).isTrue();
        assertThat(cancellation.isCanceled(7, second)).isFalse();
        assertThat(cancellation.isCanceled(7)).isFalse();
    }

    @Test
    void userStopKillsCurrentGenerationOnlyUntilNextBegin() {
        long gen = cancellation.begin(3);
        cancellation.cancel(3);
        assertThat(cancellation.isCanceled(3)).isTrue();
        assertThat(cancellation.isCanceled(3, gen)).isTrue();
        long next = cancellation.begin(3);
        assertThat(cancellation.isCanceled(3)).isFalse();
        assertThat(cancellation.isCanceled(3, next)).isFalse();
        assertThat(cancellation.isCanceled(3, gen)).isTrue();
    }
}
