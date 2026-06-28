use std::collections::BTreeSet;
use std::str::FromStr;

use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Timelike, Utc};
use chrono_tz::Tz;
use color_eyre::eyre::eyre;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::prelude::*;

const SEARCH_LIMIT_MINUTES: i64 = 60 * 24 * 366 * 5;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Schedule {
    /// Validated five-field cron expression: minute, hour, day of month, month,
    /// and day of week.
    pub cron: String,
    /// IANA timezone captured from the browser when the schedule is created.
    pub timezone: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalOccurrence {
    pub utc: DateTime<Utc>,
    pub local: NaiveDateTime,
}

impl Schedule {
    pub fn new(cron: impl Into<String>, timezone: impl Into<String>) -> Result<Self, Error> {
        let schedule = Self {
            cron: cron.into(),
            timezone: timezone.into(),
        };
        schedule.parse()?;
        Ok(schedule)
    }

    pub fn next_after(
        &self,
        after: DateTime<Utc>,
        last_local_occurrence: Option<NaiveDateTime>,
    ) -> Result<LocalOccurrence, Error> {
        let parsed = self.parse()?;
        let mut candidate = after
            .with_second(0)
            .and_then(|value| value.with_nanosecond(0))
            .ok_or_else(|| {
                Error::new(
                    eyre!("{}", t!("backup.scheduled.schedule-invalid-cursor")),
                    ErrorKind::InvalidRequest,
                )
            })?
            + Duration::minutes(1);

        for _ in 0..SEARCH_LIMIT_MINUTES {
            let local = candidate.with_timezone(&parsed.timezone).naive_local();
            if parsed.matches(local) && last_local_occurrence != Some(local) {
                return Ok(LocalOccurrence {
                    utc: candidate,
                    local,
                });
            }
            candidate += Duration::minutes(1);
        }

        Err(Error::new(
            eyre!("{}", t!("backup.scheduled.schedule-no-occurrence")),
            ErrorKind::InvalidRequest,
        ))
    }

    pub fn next_after_cursor(
        &self,
        after: DateTime<Utc>,
        last_scheduled_at: Option<DateTime<Utc>>,
    ) -> Result<LocalOccurrence, Error> {
        let timezone = self.parse()?.timezone;
        let last_local = last_scheduled_at.map(|timestamp| {
            timestamp
                .with_timezone(&timezone)
                .naive_local()
                .with_second(0)
                .and_then(|value| value.with_nanosecond(0))
                .expect("UTC timestamps always support minute precision")
        });
        self.next_after(after, last_local)
    }

    /// Returns at most one missed occurrence. Callers advance their cursor to
    /// `now` after dispatch so downtime never replays an occurrence backlog.
    pub fn catch_up_after(
        &self,
        cursor: DateTime<Utc>,
        now: DateTime<Utc>,
        last_local_occurrence: Option<NaiveDateTime>,
    ) -> Result<Option<LocalOccurrence>, Error> {
        let next = self.next_after(cursor, last_local_occurrence)?;
        Ok((next.utc <= now).then_some(next))
    }

    fn parse(&self) -> Result<ParsedSchedule, Error> {
        let timezone = Tz::from_str(&self.timezone).map_err(|_| {
            Error::new(
                eyre!(
                    "{}",
                    t!(
                        "backup.scheduled.invalid-timezone",
                        timezone = self.timezone
                    )
                ),
                ErrorKind::InvalidRequest,
            )
        })?;
        let fields: Vec<_> = self.cron.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.five-field-cron")),
                ErrorKind::InvalidRequest,
            ));
        }

        let minutes = CronField::parse(fields[0], 0, 59, false)?;
        if minutes.values.len() != 1 {
            return Err(Error::new(
                eyre!("{}", t!("backup.scheduled.hourly-limit")),
                ErrorKind::InvalidRequest,
            ));
        }

        Ok(ParsedSchedule {
            minutes,
            hours: CronField::parse(fields[1], 0, 23, false)?,
            days_of_month: CronField::parse(fields[2], 1, 31, false)?,
            months: CronField::parse(fields[3], 1, 12, false)?,
            days_of_week: CronField::parse(fields[4], 0, 7, true)?,
            timezone,
        })
    }
}

#[derive(Debug)]
struct ParsedSchedule {
    minutes: CronField,
    hours: CronField,
    days_of_month: CronField,
    months: CronField,
    days_of_week: CronField,
    timezone: Tz,
}

impl ParsedSchedule {
    fn matches(&self, local: NaiveDateTime) -> bool {
        let dom_matches = self.days_of_month.contains(local.day());
        let dow_matches = self
            .days_of_week
            .contains(local.weekday().num_days_from_sunday());
        let day_matches = match (self.days_of_month.wildcard, self.days_of_week.wildcard) {
            (true, true) => true,
            (true, false) => dow_matches,
            (false, true) => dom_matches,
            (false, false) => dom_matches || dow_matches,
        };

        self.minutes.contains(local.minute())
            && self.hours.contains(local.hour())
            && self.months.contains(local.month())
            && day_matches
    }
}

#[derive(Debug)]
struct CronField {
    values: BTreeSet<u32>,
    wildcard: bool,
}

impl CronField {
    fn parse(input: &str, min: u32, max: u32, sunday_alias: bool) -> Result<Self, Error> {
        let wildcard = input == "*";
        let mut values = BTreeSet::new();
        for part in input.split(',') {
            let (range, step) = match part.split_once('/') {
                Some((range, step)) => {
                    let step = step.parse::<u32>().map_err(|_| cron_error(input))?;
                    if step == 0 {
                        return Err(cron_error(input));
                    }
                    (range, step)
                }
                None => (part, 1),
            };

            let (start, end) = if range == "*" {
                (min, max)
            } else if let Some((start, end)) = range.split_once('-') {
                (
                    start.parse::<u32>().map_err(|_| cron_error(input))?,
                    end.parse::<u32>().map_err(|_| cron_error(input))?,
                )
            } else {
                let value = range.parse::<u32>().map_err(|_| cron_error(input))?;
                (value, value)
            };

            if start < min || end > max || start > end {
                return Err(cron_error(input));
            }
            for value in (start..=end).step_by(step as usize) {
                values.insert(if sunday_alias && value == 7 { 0 } else { value });
            }
        }
        if values.is_empty() {
            return Err(cron_error(input));
        }
        Ok(Self { values, wildcard })
    }

    fn contains(&self, value: u32) -> bool {
        self.values.contains(&value)
    }
}

fn cron_error(field: &str) -> Error {
    Error::new(
        eyre!(
            "{}",
            t!("backup.scheduled.invalid-cron-field", field = field)
        ),
        ErrorKind::InvalidRequest,
    )
}

#[cfg(test)]
mod tests {
    use chrono::{TimeZone, Timelike};

    use super::*;

    #[test]
    fn rejects_six_fields_and_sub_hourly_schedules() {
        assert!(Schedule::new("0 0 2 * * *", "UTC").is_err());
        assert!(Schedule::new("0,30 * * * *", "UTC").is_err());
        assert!(Schedule::new("*/15 * * * *", "UTC").is_err());
        assert!(Schedule::new("0 * * * *", "UTC").is_ok());
    }

    #[test]
    fn spring_forward_skips_nonexistent_occurrence() {
        let schedule = Schedule::new("30 2 * * *", "America/New_York").unwrap();
        let before = Utc.with_ymd_and_hms(2025, 3, 9, 6, 0, 0).unwrap();
        let occurrence = schedule.next_after(before, None).unwrap();
        assert_eq!(
            occurrence.utc,
            Utc.with_ymd_and_hms(2025, 3, 10, 6, 30, 0).unwrap()
        );
    }

    #[test]
    fn fall_back_repeated_occurrence_runs_once() {
        let schedule = Schedule::new("30 1 * * *", "America/New_York").unwrap();
        let before = Utc.with_ymd_and_hms(2025, 11, 2, 4, 0, 0).unwrap();
        let first = schedule.next_after(before, None).unwrap();
        assert_eq!(
            first.utc,
            Utc.with_ymd_and_hms(2025, 11, 2, 5, 30, 0).unwrap()
        );

        let next = schedule.next_after(first.utc, Some(first.local)).unwrap();
        assert_eq!(
            next.utc,
            Utc.with_ymd_and_hms(2025, 11, 3, 6, 30, 0).unwrap()
        );

        let from_persisted_cursor = schedule
            .next_after_cursor(first.utc, Some(first.utc))
            .unwrap();
        assert_eq!(from_persisted_cursor.utc, next.utc);
    }

    #[test]
    fn downtime_yields_only_one_catch_up_occurrence() {
        let schedule = Schedule::new("0 * * * *", "UTC").unwrap();
        let cursor = Utc.with_ymd_and_hms(2025, 1, 1, 0, 5, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2025, 1, 1, 8, 5, 0).unwrap();
        let due = schedule.catch_up_after(cursor, now, None).unwrap().unwrap();
        assert_eq!(due.utc.hour(), 1);
    }

    #[test]
    fn standard_day_of_month_or_day_of_week_semantics() {
        let schedule = Schedule::new("0 9 1 * 1", "UTC").unwrap();
        let before = Utc.with_ymd_and_hms(2025, 1, 1, 9, 1, 0).unwrap();
        let next = schedule.next_after(before, None).unwrap();
        assert_eq!(next.utc, Utc.with_ymd_and_hms(2025, 1, 6, 9, 0, 0).unwrap());
    }
}
