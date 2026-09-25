/// Pomodoro round sequencing: work → short-break → work → … → long-break → work (cycle).
///
/// Mirrors the original app's behaviour:
/// - After each completed work round, check if `work_round_number >= work_rounds_total`.
///   If yes → long break; otherwise → short break.
/// - After short break → advance work_round_number, next round is Work.
/// - After long break → reset work_round_number to 1, next round is Work.
use serde::{Deserialize, Serialize};

use crate::settings::Settings;

// ---------------------------------------------------------------------------
// Round type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoundType {
    Work,
    ShortBreak,
    LongBreak,
}

impl RoundType {
    pub fn as_str(self) -> &'static str {
        match self {
            RoundType::Work => "work",
            RoundType::ShortBreak => "short-break",
            RoundType::LongBreak => "long-break",
        }
    }
}

// ---------------------------------------------------------------------------
// Sequence state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SequenceState {
    pub current_round: RoundType,
    /// The round type that was active before `advance()` was last called.
    /// `None` on the very first round (no preceding round exists).
    pub previous_round: Option<RoundType>,
    /// Which work round we're currently in (1-based). Displayed to the user.
    pub work_round_number: u32,
    /// Total work rounds before a long break (from settings).
    pub work_rounds_total: u32,
    /// Monotonically-increasing count of work rounds since the last reset.
    /// Unlike `work_round_number` this never resets at cycle boundaries,
    /// so it can be used as a session counter when long breaks are disabled.
    pub session_work_count: u32,
    /// Work rounds finished since the current ladder began. Drives the
    /// incremental focus mode and resets at every long-break boundary (and on
    /// a full Reset), so each new cycle starts at the base duration again.
    pub work_rounds_completed: u32,
}

impl SequenceState {
    pub fn new(work_rounds_total: u32) -> Self {
        Self {
            current_round: RoundType::Work,
            previous_round: None,
            work_round_number: 1,
            work_rounds_total,
            session_work_count: 1,
            work_rounds_completed: 0,
        }
    }

    /// Duration of the current round in seconds, taken from settings.
    ///
    /// In incremental focus mode a work round is lengthened by
    /// `time_work_increment_secs` for every work round already completed in the
    /// current ladder, capped at `time_work_max_secs` and never shorter than the
    /// configured base duration. Break durations are never escalated.
    pub fn current_duration_secs(&self, settings: &Settings) -> u32 {
        match self.current_round {
            RoundType::Work => self.work_duration_secs(settings),
            RoundType::ShortBreak => settings.time_short_break_secs,
            RoundType::LongBreak => settings.time_long_break_secs,
        }
    }

    /// The work duration that applies to the current ladder position.
    pub fn work_duration_secs(&self, settings: &Settings) -> u32 {
        let base = settings.time_work_secs;
        if !settings.incremental_work_enabled || settings.time_work_increment_secs == 0 {
            return base;
        }
        let step = settings
            .time_work_increment_secs
            .saturating_mul(self.work_rounds_completed);
        base.saturating_add(step).min(settings.time_work_max_secs.max(base))
    }

    /// How many increments have been applied to the work duration right now.
    /// Used by the frontend to show the current step on the ladder.
    pub fn work_increment_steps(&self, settings: &Settings) -> u32 {
        if !settings.incremental_work_enabled || settings.time_work_increment_secs == 0 {
            return 0;
        }
        self.work_rounds_completed
    }

    /// True when the current work duration has reached the configured ceiling
    /// and further rounds will no longer grow.
    pub fn work_duration_at_cap(&self, settings: &Settings) -> bool {
        if !settings.incremental_work_enabled || settings.time_work_increment_secs == 0 {
            return false;
        }
        let cap = settings.time_work_max_secs.max(settings.time_work_secs);
        let uncapped = settings
            .time_work_secs
            .saturating_add(settings.time_work_increment_secs.saturating_mul(self.work_rounds_completed));
        uncapped >= cap
    }

    /// Advance to the next round.  Returns `(next_round_type, duration_secs)`.
    ///
    /// Call this when the engine fires `TimerEvent::Complete`.
    pub fn advance(&mut self, settings: &Settings) -> (RoundType, u32) {
        self.previous_round = Some(self.current_round);
        let left_work_round = self.current_round == RoundType::Work;
        self.current_round = match self.current_round {
            RoundType::Work => {
                if self.work_round_number >= self.work_rounds_total {
                    // At the long-break point.
                    if settings.long_breaks_enabled {
                        RoundType::LongBreak
                    } else if settings.short_breaks_enabled {
                        // Substitute a short break; set to 0 so the ShortBreak→Work arm
                        // increments it to 1, preserving the cycle-reset invariant.
                        self.work_round_number = 0;
                        RoundType::ShortBreak
                    } else {
                        // Both breaks disabled: loop directly back to Work(1).
                        self.work_round_number = 1;
                        RoundType::Work
                    }
                } else if settings.short_breaks_enabled {
                    RoundType::ShortBreak
                } else {
                    // Short breaks disabled: skip directly to the next work round.
                    self.work_round_number += 1;
                    RoundType::Work
                }
            }
            RoundType::ShortBreak => {
                self.work_round_number += 1;
                RoundType::Work
            }
            RoundType::LongBreak => {
                self.work_round_number = 1;
                RoundType::Work
            }
        };

        // A completed work round extends the ladder for the rounds that follow.
        // Counted before the duration is computed so the very next work round
        // already reflects the increment.
        if left_work_round {
            self.work_rounds_completed = self.work_rounds_completed.saturating_add(1);
        }

        // Leaving a long break (or wrapping the cycle when breaks are disabled)
        // starts a fresh ladder from the base duration.
        if self.current_round == RoundType::Work && self.work_round_number == 1 {
            self.work_rounds_completed = 0;
        }

        // Increment the session counter every time we enter a new Work round.
        if self.current_round == RoundType::Work {
            self.session_work_count += 1;
        }

        let duration = self.current_duration_secs(settings);
        (self.current_round, duration)
    }

    /// Reset the sequence to the initial state (used by the Reset command).
    pub fn reset(&mut self) {
        self.current_round = RoundType::Work;
        self.previous_round = None;
        self.work_round_number = 1;
        self.session_work_count = 1;
        self.work_rounds_completed = 0;
    }
}

// ---------------------------------------------------------------------------
// Tests (TIMER-02 acceptance: full cycles with various work_rounds values)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal `Settings` with the given durations.
    fn settings(work: u32, short: u32, long: u32) -> Settings {
        Settings {
            time_work_secs: work,
            time_short_break_secs: short,
            time_long_break_secs: long,
            long_break_interval: 4,
            ..Settings::default()
        }
    }

    /// Build settings with break-enable flags set explicitly.
    fn settings_with_flags(short_breaks_enabled: bool, long_breaks_enabled: bool) -> Settings {
        Settings {
            time_work_secs: 1500,
            time_short_break_secs: 300,
            time_long_break_secs: 900,
            long_break_interval: 4,
            short_breaks_enabled,
            long_breaks_enabled,
            ..Settings::default()
        }
    }

    /// Simulate `n` full cycles (each cycle = work_rounds × work + breaks + long break)
    /// and return a flat list of (round_type, duration) pairs.
    fn simulate_cycle(work_rounds: u32, cycles: u32) -> Vec<(RoundType, u32)> {
        let s = settings(1500, 300, 900);
        let mut seq = SequenceState::new(work_rounds);
        let mut result = Vec::new();

        // Record initial state.
        result.push((seq.current_round, seq.current_duration_secs(&s)));

        let total_rounds_per_cycle = work_rounds * 2; // work + break per work session, then long
        let steps = total_rounds_per_cycle * cycles;

        for _ in 0..steps {
            let (rt, dur) = seq.advance(&s);
            result.push((rt, dur));
        }
        result
    }

    #[test]
    fn single_work_round_cycle() {
        // work_rounds=1: Work → LongBreak → Work → LongBreak → …
        let rounds = simulate_cycle(1, 3);
        let types: Vec<_> = rounds.iter().map(|(rt, _)| *rt).collect();
        assert_eq!(
            types,
            vec![
                RoundType::Work,
                RoundType::LongBreak,
                RoundType::Work,
                RoundType::LongBreak,
                RoundType::Work,
                RoundType::LongBreak,
                RoundType::Work,
            ]
        );
    }

    #[test]
    fn two_work_rounds_cycle() {
        // work_rounds=2: Work → Short → Work → Long → Work → Short → …
        let rounds = simulate_cycle(2, 2);
        let types: Vec<_> = rounds.iter().map(|(rt, _)| *rt).collect();
        assert_eq!(
            types,
            vec![
                RoundType::Work,
                RoundType::ShortBreak,
                RoundType::Work,
                RoundType::LongBreak,
                RoundType::Work,
                RoundType::ShortBreak,
                RoundType::Work,
                RoundType::LongBreak,
                RoundType::Work,
            ]
        );
    }

    #[test]
    fn four_work_rounds_cycle() {
        // The default work_rounds=4 cycle.
        let s = settings(1500, 300, 900);
        let mut seq = SequenceState::new(4);

        // Initial state check (before any advance).
        assert_eq!(seq.current_round, RoundType::Work);
        assert_eq!(seq.current_duration_secs(&s), 1500);

        // Expected results of successive advance() calls.
        let expected = vec![
            (RoundType::ShortBreak, 300u32), // Work(1) → ShortBreak
            (RoundType::Work, 1500),          // ShortBreak → Work(2)
            (RoundType::ShortBreak, 300),     // Work(2) → ShortBreak
            (RoundType::Work, 1500),          // ShortBreak → Work(3)
            (RoundType::ShortBreak, 300),     // Work(3) → ShortBreak
            (RoundType::Work, 1500),          // ShortBreak → Work(4)
            (RoundType::LongBreak, 900),      // Work(4) → LongBreak (4 == total)
            (RoundType::Work, 1500),          // LongBreak → Work(1) — cycle 2
            (RoundType::ShortBreak, 300),     // Work(1) → ShortBreak
        ];

        for (i, (exp_type, exp_dur)) in expected.iter().enumerate() {
            let (rt, dur) = seq.advance(&s);
            assert_eq!(
                rt, *exp_type,
                "step {i}: expected {exp_type:?}, got {rt:?}"
            );
            assert_eq!(
                dur, *exp_dur,
                "step {i}: expected duration {exp_dur}, got {dur}"
            );
        }
    }

    #[test]
    fn twelve_work_rounds_cycle() {
        let s = settings(1500, 300, 900);
        let mut seq = SequenceState::new(12);

        // Simulate one full cycle: 12 work + 11 short + 1 long = 24 advances.
        let mut work_count = 0;
        let mut short_count = 0;
        let mut long_count = 0;

        for _ in 0..24 {
            let (rt, _) = seq.advance(&s);
            match rt {
                RoundType::Work => work_count += 1,
                RoundType::ShortBreak => short_count += 1,
                RoundType::LongBreak => long_count += 1,
            }
        }

        // After 24 advances from the initial Work state we should have:
        // 11 short breaks, 1 long break, and 12 work rounds.
        assert_eq!(short_count, 11, "12-round cycle should have 11 short breaks");
        assert_eq!(long_count, 1, "12-round cycle should have 1 long break");
        assert_eq!(work_count, 12, "12-round cycle should have 12 work rounds");
    }

    #[test]
    fn work_round_number_resets_after_long_break() {
        let s = settings(1500, 300, 900);
        let mut seq = SequenceState::new(2);

        seq.advance(&s); // → ShortBreak
        assert_eq!(seq.work_round_number, 1);

        seq.advance(&s); // → Work(2)
        assert_eq!(seq.work_round_number, 2);

        seq.advance(&s); // → LongBreak
        assert_eq!(seq.work_round_number, 2, "number stays during long break");

        seq.advance(&s); // → Work(1) — cycle reset
        assert_eq!(seq.work_round_number, 1, "number must reset to 1 after long break");
    }

    #[test]
    fn reset_returns_to_initial_state() {
        let s = settings(1500, 300, 900);
        let mut seq = SequenceState::new(4);

        seq.advance(&s);
        seq.advance(&s);
        seq.reset();

        assert_eq!(seq.current_round, RoundType::Work);
        assert_eq!(seq.work_round_number, 1);
        assert_eq!(seq.current_duration_secs(&s), 1500);
    }

    #[test]
    fn work_round_number_increments_on_each_work_completion() {
        // Verifies that work_round_number advances by 1 after each Work→Break→Work
        // transition and resets to 1 after a long break.
        let s = settings(1500, 300, 900);
        let mut seq = SequenceState::new(4);

        assert_eq!(seq.work_round_number, 1, "initial work_round_number is 1");

        // Complete work rounds 1→2→3→4.
        for expected in 2..=4u32 {
            seq.advance(&s); // Work(n) → ShortBreak
            seq.advance(&s); // ShortBreak → Work(n+1)
            assert_eq!(
                seq.work_round_number, expected,
                "work_round_number should be {expected} after completing round {}",
                expected - 1
            );
        }

        // Work(4) → LongBreak → Work(1).
        seq.advance(&s); // → LongBreak
        seq.advance(&s); // → Work(1)
        assert_eq!(
            seq.work_round_number, 1,
            "work_round_number must reset to 1 after long break"
        );
    }

    // -----------------------------------------------------------------------
    // Optional-breaks tests
    // -----------------------------------------------------------------------

    #[test]
    fn short_breaks_disabled_chains_work_rounds() {
        // short=false, long=true: Work rounds chain directly; long break still fires.
        let s = settings_with_flags(false, true);
        let mut seq = SequenceState::new(4);

        // Work(1) → Work(2) → Work(3) → Work(4) → LongBreak → Work(1)
        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 2);

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 3);

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 4);

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::LongBreak, "long break must still fire at round 4");

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 1, "counter must reset to 1 after long break");
    }

    #[test]
    fn long_breaks_disabled_substitutes_short_break() {
        // short=true, long=false: short break substituted at the long-break point.
        let s = settings_with_flags(true, false);
        let mut seq = SequenceState::new(2);

        // Work(1) → ShortBreak (normal) → Work(2) → ShortBreak (substituted) → Work(1)
        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::ShortBreak, "normal short break before long-break point");

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 2);

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::ShortBreak, "short break substituted at long-break point");

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 1, "counter must reset to 1 after substituted short break");
    }

    #[test]
    fn both_breaks_disabled_pure_work_loop() {
        // short=false, long=false: pure work loop; counter increments and resets.
        let s = settings_with_flags(false, false);
        let mut seq = SequenceState::new(3);

        // Work(1) → Work(2) → Work(3) → Work(1) — cycle
        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 2);

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 3);

        // At long-break point with both disabled → Work(1)
        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 1, "counter must reset to 1 at cycle boundary");

        // Continues correctly in the next cycle.
        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 2);
    }

    #[test]
    fn long_breaks_disabled_short_breaks_fire_normally() {
        // short=true, long=false: short breaks still fire before the long-break point.
        let s = settings_with_flags(true, false);
        let mut seq = SequenceState::new(3);

        // Work(1) → ShortBreak → Work(2) → ShortBreak → Work(3) → ShortBreak* → Work(1)
        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::ShortBreak, "short break fires at round 1 (before long-break point)");

        seq.advance(&s); // → Work(2)

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::ShortBreak, "short break fires at round 2 (before long-break point)");

        seq.advance(&s); // → Work(3)

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::ShortBreak, "short break substituted at long-break point when long=false");

        let (rt, _) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(seq.work_round_number, 1, "counter resets to 1");
    }

    // -----------------------------------------------------------------------
    // Incremental focus mode
    // -----------------------------------------------------------------------

    /// Settings with incremental focus enabled: 5 min base, +5 min per round, 20 min cap.
    fn incremental_settings() -> Settings {
        Settings {
            time_work_secs: 5 * 60,
            time_short_break_secs: 5 * 60,
            time_long_break_secs: 15 * 60,
            long_break_interval: 4,
            incremental_work_enabled: true,
            time_work_increment_secs: 5 * 60,
            time_work_max_secs: 20 * 60,
            ..Settings::default()
        }
    }

    #[test]
    fn incremental_disabled_keeps_flat_duration() {
        let s = Settings {
            time_work_secs: 5 * 60,
            time_short_break_secs: 5 * 60,
            time_long_break_secs: 15 * 60,
            long_break_interval: 2,
            incremental_work_enabled: false,
            time_work_increment_secs: 5 * 60,
            time_work_max_secs: 20 * 60,
            ..Settings::default()
        };
        let mut seq = SequenceState::new(2);

        assert_eq!(seq.current_duration_secs(&s), 5 * 60);
        for _ in 0..6 {
            let (rt, dur) = seq.advance(&s);
            if rt == RoundType::Work {
                assert_eq!(dur, 5 * 60, "work duration must stay flat when the feature is off");
            }
        }
    }

    #[test]
    fn incremental_escalates_work_rounds_and_caps() {
        let s = incremental_settings();
        let mut seq = SequenceState::new(6);

        // Round 1 starts at the base duration.
        assert_eq!(seq.current_duration_secs(&s), 300, "first round is the base duration");

        // Each Work round is 5 min longer than the previous, until the 20 min cap.
        let expected_work = [300u32, 600, 900, 1200, 1200, 1200];
        for (i, want) in expected_work.iter().enumerate() {
            if i > 0 {
                // Advance Work → ShortBreak → Work.
                let (rt, dur) = seq.advance(&s);
                assert_eq!(rt, RoundType::ShortBreak);
                assert_eq!(dur, 300, "break durations are never escalated");
                seq.advance(&s);
            }
            assert_eq!(
                seq.current_round,
                RoundType::Work,
                "step {i}: expected to be on a work round"
            );
            assert_eq!(
                seq.current_duration_secs(&s),
                *want,
                "step {i}: unexpected work duration"
            );
        }
    }

    #[test]
    fn incremental_ladder_resets_after_long_break() {
        let s = incremental_settings();
        let mut seq = SequenceState::new(2);

        assert_eq!(seq.current_duration_secs(&s), 300);

        seq.advance(&s); // → ShortBreak
        let (rt, dur) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(dur, 600, "second work round gains one increment");

        let (rt, _dur) = seq.advance(&s);
        assert_eq!(rt, RoundType::LongBreak, "long break at the cycle boundary");
        assert_eq!(seq.work_rounds_completed, 2);

        let (rt, dur) = seq.advance(&s);
        assert_eq!(rt, RoundType::Work);
        assert_eq!(dur, 300, "a new cycle restarts at the base duration");
        assert_eq!(seq.work_rounds_completed, 0, "ladder resets at the cycle boundary");
    }

    #[test]
    fn incremental_ladder_resets_on_manual_reset() {
        let s = incremental_settings();
        let mut seq = SequenceState::new(8);

        seq.advance(&s); // → ShortBreak
        seq.advance(&s); // → Work (600s)
        assert_eq!(seq.current_duration_secs(&s), 600);

        seq.reset();
        assert_eq!(seq.work_rounds_completed, 0);
        assert_eq!(seq.current_duration_secs(&s), 300, "reset returns to the base duration");
    }

    #[test]
    fn incremental_never_shrinks_below_base_when_cap_is_smaller() {
        let s = Settings {
            time_work_secs: 25 * 60,
            incremental_work_enabled: true,
            time_work_increment_secs: 5 * 60,
            time_work_max_secs: 10 * 60, // misconfigured: cap below the base
            long_break_interval: 4,
            ..Settings::default()
        };
        let seq = SequenceState::new(4);
        assert_eq!(
            seq.current_duration_secs(&s),
            25 * 60,
            "cap below the base duration must not shorten the work round"
        );
    }

    #[test]
    fn incremental_steps_and_cap_flags_track_the_ladder() {
        let s = incremental_settings();
        let mut seq = SequenceState::new(5);

        assert_eq!(seq.work_increment_steps(&s), 0);
        assert!(!seq.work_duration_at_cap(&s));

        // Work(1)→SB→Work(2)→SB→Work(3)→SB→Work(4)→SB→Work(5)→Long → Work(1)
        // — a full cycle, which restarts the ladder.
        for _ in 0..10 {
            seq.advance(&s);
        }
        assert_eq!(seq.current_round, RoundType::Work);
        assert_eq!(seq.work_round_number, 1, "back at the start of a new cycle");
        assert_eq!(seq.work_increment_steps(&s), 0, "ladder restarts each cycle");
        assert!(!seq.work_duration_at_cap(&s));
        assert_eq!(seq.current_duration_secs(&s), 300);

        // Walk part-way into the next cycle and confirm the cap has engaged.
        for _ in 0..3 {
            seq.advance(&s); // Work(2) → SB → Work(3) → SB → Work(4)
            seq.advance(&s);
        }
        assert_eq!(seq.current_round, RoundType::ShortBreak);
        assert_eq!(seq.work_increment_steps(&s), 3);
        assert!(seq.work_duration_at_cap(&s), "900 + 300×3 is past the 1200 s cap");
        assert_eq!(seq.work_duration_secs(&s), 1200);
    }
}
