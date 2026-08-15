import AppError from "../errors/AppError.js";
import { Course } from "../models/course.model.js";
import { Progress } from "../models/progress.model.js";
import { Student } from "../models/student.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";
import { Teacher } from "../models/teacher.model.js";
import { User } from "../models/user.model.js";
import { normalizeGradeLevel } from "../utils/grade.js";
import { parsePagination, getPaginationMeta } from "../utils/pagination.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";

const buildSearchRegex = (value) =>
  new RegExp(
    String(value)
      .trim()
      .replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"),
    "i",
  );

const getTeacherDoc = async (userId) =>
  Teacher.findOne({ user: userId })
    .populate("courses", "name")
    .populate("school", "name schoolCode");

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const ACTIVE_LOGIN_WINDOW_DAYS = 30;

const normalizeFilterValue = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const isAllFilter = (value) => {
  const normalized = normalizeFilterValue(value);
  return !normalized || normalized === "all";
};

const getDateRangeFromPeriod = (period) => {
  const now = new Date();
  const normalized = normalizeFilterValue(period);
  const start = new Date(now);

  switch (normalized) {
    case "today":
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "day" };
    case "past week":
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "day" };
    case "past 1 month":
      start.setMonth(now.getMonth() - 1);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "day" };
    case "past 3 months":
      start.setMonth(now.getMonth() - 3);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "month" };
    case "past 6 months":
      start.setMonth(now.getMonth() - 6);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "month" };
    case "past year":
    default:
      start.setFullYear(now.getFullYear() - 1);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, key: "month" };
  }
};

const normalizeSubjectName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ");

const matchesSubjectFilter = (courseName, subject) => {
  if (isAllFilter(subject)) return true;

  const normalizedSubject = normalizeSubjectName(subject);
  const normalizedCourse = normalizeSubjectName(courseName);

  const aliases = {
    english: ["english"],
    science: ["science"],
    math: ["math", "mathematics"],
    "religious and moral education": ["religious and moral education"],
    "social studies": ["social studies", "social science"],
    "social science": ["social studies", "social science"],
  };

  const subjectAliases = aliases[normalizedSubject] || [normalizedSubject];

  return subjectAliases.some(
    (alias) =>
      normalizedCourse === alias ||
      normalizedCourse.includes(alias) ||
      alias.includes(normalizedCourse),
  );
};

const resolveTeacherCourseIds = (teacherCourses = [], subject = "ALL") => {
  if (isAllFilter(subject)) {
    return teacherCourses.map((course) => course._id);
  }

  return teacherCourses
    .filter((course) => matchesSubjectFilter(course.name, subject))
    .map((course) => course._id);
};

const getGradeLevelFilter = (gradeLevel, fallback = "ALL") => {
  const normalized = normalizeGradeLevel(gradeLevel || fallback);
  return isAllFilter(normalized) ? null : normalized;
};

const getOverviewGradeLevel = (gradeLevel) => {
  const normalized = normalizeGradeLevel(gradeLevel);
  return isAllFilter(normalized) ? null : normalized;
};

const buildStudentProgressMatch = ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
  dateField = "lastUpdated",
}) => {
  const match = { student: studentId };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  const normalizedGradeLevel = getOverviewGradeLevel(gradeLevel);
  if (normalizedGradeLevel) {
    match.gradeName = normalizedGradeLevel;
  }

  if (range) {
    match[dateField] = { $gte: range.start, $lte: range.end };
  }

  return match;
};

const getStudentLoginStatus = (lastLoginAt) => {
  if (!lastLoginAt) return "inactive";

  const lastLoginTime = new Date(lastLoginAt).getTime();
  if (Number.isNaN(lastLoginTime)) return "inactive";

  return Date.now() - lastLoginTime <= ACTIVE_LOGIN_WINDOW_DAYS * DAY_IN_MS
    ? "active"
    : "inactive";
};

const buildDateRangeMatch = (range, dateField = "lastUpdated") =>
  range ? { [dateField]: { $gte: range.start, $lte: range.end } } : {};

const buildSeriesBuckets = (range) => {
  if (!range) return [];

  const buckets = [];
  const cursor = new Date(range.start);
  cursor.setHours(0, 0, 0, 0);

  if (range.key === "day") {
    while (cursor <= range.end) {
      const key = cursor.toISOString().slice(0, 10);
      buckets.push({
        key,
        label: cursor.toLocaleDateString("en-US", { weekday: "short" }),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return buckets;
  }

  cursor.setDate(1);
  while (cursor <= range.end) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({
      key,
      label: cursor.toLocaleDateString("en-US", { month: "short" }),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return buckets;
};

const mapBucketKey = (date, keyType) => {
  const current = new Date(date);
  if (keyType === "day") {
    return current.toISOString().slice(0, 10);
  }
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;
};

const buildPeriodSeries = (raw, range) => {
  const buckets = buildSeriesBuckets(range);
  if (!buckets.length) return [];

  return buckets.map((bucket) => {
    const found = raw.find((item) => item.bucket === bucket.key);
    return {
      label: bucket.label,
      key: bucket.key,
      total: found?.total || 0,
      avgQuizScore: found?.avgQuizScore || 0,
    };
  });
};

const buildStudentStatusCounts = (students = []) =>
  students.reduce(
    (acc, student) => {
      const status = getStudentLoginStatus(student.user?.lastLoginAt);
      acc[status] += 1;
      return acc;
    },
    { active: 0, inactive: 0 },
  );

const getRangeDays = (range) => {
  if (!range?.start || !range?.end) return null;
  const diff = Math.ceil(
    (new Date(range.end).getTime() - new Date(range.start).getTime()) /
      DAY_IN_MS,
  );
  return Math.max(diff + 1, 1);
};

const getEffectiveMinutesFromRecords = (records = []) => {
  let totalMinutes = 0;

  for (const record of records) {
    const minutes = record.activityMinutes || 0;
    const activityType = record.activityType?.toLowerCase() || "";

    // If we have actual minutes and not the legacy 30, use them
    if (minutes > 0 && minutes !== 30) {
      totalMinutes += minutes;
    } else {
      // Apply Flutter's new logic: 20 mins for core tasks, 2 mins for others
      if (["quiz", "independent", "guided_practice"].includes(activityType)) {
        totalMinutes += 20;
      } else {
        totalMinutes += 2; // get_ready, learn, etc.
      }
    }
  }

  return totalMinutes;
};

const getStudentProgressSummary = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
  timePeriod = "Today", // Add this parameter
}) => {
  const match = buildStudentProgressMatch({
    studentId,
    courseIds,
    gradeLevel,
    range,
  });

  const records = await Progress.find(match).lean();

  // Calculate days based on timePeriod string, NOT date range
  const getDaysFromPeriod = (period) => {
    const normalized = normalizeFilterValue(period);
    switch (normalized) {
      case "today":
        return 1;
      case "past week":
        return 7;
      case "past 1 month":
        return 30;
      case "past 3 months":
        return 90;
      case "past 6 months":
        return 180;
      case "past year":
        return 365;
      default:
        return 1;
    }
  };

  const daysInPeriod = getDaysFromPeriod(timePeriod);

  let totalMinutes = 0;
  let totalQuizPercentage = 0;
  let quizCount = 0;

  for (const record of records) {
    const minutes = record.activityMinutes || 0;
    const activityType = record.activityType?.toLowerCase() || "";

    // Flutter's exact logic
    if (minutes > 0 && minutes !== 30) {
      totalMinutes += minutes;
    } else {
      if (["quiz", "independent", "guided_practice"].includes(activityType)) {
        totalMinutes += 20;
      } else {
        totalMinutes += 2;
      }
    }

    // Quiz score as percentage
    if (
      activityType === "quiz" &&
      record.score !== null &&
      record.totalQuestions &&
      record.totalQuestions > 0
    ) {
      totalQuizPercentage += (record.score / record.totalQuestions) * 100;
      quizCount++;
    }
  }

  const totalHours = totalMinutes / 60;
  const avgDailyHours = totalHours / daysInPeriod; // Use daysInPeriod here
  const avgQuizScore = quizCount > 0 ? totalQuizPercentage / quizCount : 0;

  // Subject progress (unchanged)
  const bySubject = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$course",
        total: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
        },
      },
    },
    {
      $lookup: {
        from: "courses",
        localField: "_id",
        foreignField: "_id",
        as: "course",
      },
    },
    { $unwind: "$course" },
    {
      $project: {
        _id: 0,
        subject: "$course.name",
        completionRate: {
          $cond: [
            { $eq: ["$total", 0] },
            0,
            {
              $round: [
                { $multiply: [{ $divide: ["$completed", "$total"] }, 100] },
                2,
              ],
            },
          ],
        },
      },
    },
  ]);

  return {
    summary: {
      activityCount: records.length,
      totalHours: Number(totalHours.toFixed(1)),
      avgDailyHours: Number(avgDailyHours.toFixed(1)),
      avgQuizScore: Number(avgQuizScore.toFixed(1)),
    },
    subjectProgress: bySubject,
  };
};

const getCourseWiseOverview = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
  timePeriod = "Today", // Add this
}) => {
  const match = buildStudentProgressMatch({
    studentId,
    courseIds,
    gradeLevel,
    range,
  });

  const records = await Progress.find(match).lean();

  const getDaysFromPeriod = (period) => {
    const normalized = normalizeFilterValue(period);
    switch (normalized) {
      case "today":
        return 1;
      case "past week":
        return 7;
      case "past 1 month":
        return 30;
      case "past 3 months":
        return 90;
      case "past 6 months":
        return 180;
      case "past year":
        return 365;
      default:
        return 1;
    }
  };

  const daysInPeriod = getDaysFromPeriod(timePeriod);

  // Group by course
  const courseMap = new Map();

  for (const record of records) {
    const courseId = record.course?.toString();
    if (!courseId) continue;

    if (!courseMap.has(courseId)) {
      courseMap.set(courseId, {
        courseId,
        totalMinutes: 0,
        completedCount: 0,
        totalCount: 0,
        quizScores: [],
      });
    }

    const courseData = courseMap.get(courseId);

    const minutes = record.activityMinutes || 0;
    const activityType = record.activityType?.toLowerCase() || "";

    if (minutes > 0 && minutes !== 30) {
      courseData.totalMinutes += minutes;
    } else {
      if (["quiz", "independent", "guided_practice"].includes(activityType)) {
        courseData.totalMinutes += 20;
      } else {
        courseData.totalMinutes += 2;
      }
    }

    courseData.totalCount++;
    if (record.status === "completed") courseData.completedCount++;

    if (
      activityType === "quiz" &&
      record.score !== null &&
      record.totalQuestions > 0
    ) {
      courseData.quizScores.push((record.score / record.totalQuestions) * 100);
    }
  }

  const courses = await Course.find({
    _id: { $in: [...courseMap.keys()] },
  }).lean();
  const courseNameMap = new Map(courses.map((c) => [c._id.toString(), c.name]));

  const result = [];

  for (const [courseId, data] of courseMap.entries()) {
    const totalHours = data.totalMinutes / 60;
    const avgDailyHours = totalHours / daysInPeriod;
    const avgQuizScore =
      data.quizScores.length > 0
        ? data.quizScores.reduce((a, b) => a + b, 0) / data.quizScores.length
        : 0;
    const completionRate =
      data.totalCount > 0 ? (data.completedCount / data.totalCount) * 100 : 0;

    result.push({
      courseId,
      subject: courseNameMap.get(courseId) || "Unknown",
      avgDailyHours: Number(avgDailyHours.toFixed(1)),
      avgQuizScore: Number(avgQuizScore.toFixed(1)),
      completionRate: Number(completionRate.toFixed(2)),
    });
  }

  return result.sort((a, b) => a.subject.localeCompare(b.subject));
};

const buildWeeklyActivitySeries = async (match) => {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - 6);

  const pipeline = [
    {
      $match: {
        ...match,
        lastUpdated: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$lastUpdated" } },
          weekday: { $dayOfWeek: "$lastUpdated" },
        },
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: { $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        date: "$_id.day",
        weekday: "$_id.weekday",
        avgDailyHours: { $round: [{ $divide: ["$totalMinutes", 60] }, 2] },
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { date: 1 } },
  ];

  const raw = await Progress.aggregate(pipeline);

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const dateObj = new Date(now);
    dateObj.setDate(now.getDate() - i);
    const iso = dateObj.toISOString().slice(0, 10);
    const found = raw.find((item) => item.date === iso);
    days.push({
      label: dayLabels[dateObj.getDay()],
      date: iso,
      avgDailyHours: found?.avgDailyHours || 0,
      avgQuizScore: found?.avgQuizScore || 0,
    });
  }

  const totals = days.reduce(
    (acc, cur) => ({
      avgDailyHoursSum: Number(
        (acc.avgDailyHoursSum + cur.avgDailyHours).toFixed(2),
      ),
      avgQuizScoreSum:
        acc.avgQuizScoreSum + (Number(cur.avgQuizScore) || 0) / days.length,
    }),
    { avgDailyHoursSum: 0, avgQuizScoreSum: 0 },
  );

  return {
    days,
    totals: {
      avgQuizScore: Number(totals.avgQuizScoreSum.toFixed(2)),
      avgDailyHours: Number((totals.avgDailyHoursSum / days.length).toFixed(2)),
    },
  };
};

const getMonthlyCompletionByCourse = async (courseIds) => {
  if (!courseIds.length) return [];

  const docs = await Progress.aggregate([
    {
      $match: {
        status: "completed",
        course: { $in: courseIds },
      },
    },
    {
      $group: {
        _id: {
          course: "$course",
          year: { $year: "$lastUpdated" },
          month: { $month: "$lastUpdated" },
        },
        completed: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: "courses",
        localField: "_id.course",
        foreignField: "_id",
        as: "course",
      },
    },
    { $unwind: "$course" },
    {
      $project: {
        _id: 0,
        courseId: "$course._id",
        subject: "$course.name",
        year: "$_id.year",
        month: "$_id.month",
        completed: 1,
      },
    },
    { $sort: { year: 1, month: 1 } },
  ]);

  return docs;
};

const getCompletionTrend = async ({
  studentIds = [],
  courseIds = [],
  range,
}) => {
  if (!studentIds.length) return [];

  const match = {
    student: { $in: studentIds },
    status: "completed",
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  if (range) {
    match.lastUpdated = { $gte: range.start, $lte: range.end };
  }

  const bucketFormat = range?.key === "day" ? "%Y-%m-%d" : "%Y-%m";

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          bucket: {
            $dateToString: { format: bucketFormat, date: "$lastUpdated" },
          },
        },
        total: { $sum: 1 },
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: {
            $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        bucket: "$_id.bucket",
        total: 1,
        totalMinutes: 1,
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { bucket: 1 } },
  ]);

  return buildPeriodSeries(raw, range).map((item) => ({
    ...item,
    avgQuizScore: Number(item.avgQuizScore || 0),
  }));
};

const getSubjectPerformanceSeries = async ({
  studentIds = [],
  courseIds = [],
  range,
}) => {
  if (!studentIds.length) return [];

  const match = {
    student: { $in: studentIds },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  if (range) {
    match.lastUpdated = { $gte: range.start, $lte: range.end };
  }

  const rangeDays = range
    ? Math.max(
        Math.ceil((range.end.getTime() - range.start.getTime()) / DAY_IN_MS),
        1,
      )
    : 7;

  const raw = await Progress.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$course",
        totalMinutes: { $sum: "$activityMinutes" },
        avgQuizScore: {
          $avg: {
            $cond: [{ $eq: ["$activityType", "quiz"] }, "$score", null],
          },
        },
        totalActivities: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: "courses",
        localField: "_id",
        foreignField: "_id",
        as: "course",
      },
    },
    { $unwind: "$course" },
    {
      $project: {
        _id: 0,
        subject: "$course.name",
        totalMinutes: 1,
        totalActivities: 1,
        avgQuizScore: { $round: ["$avgQuizScore", 2] },
      },
    },
    { $sort: { subject: 1 } },
  ]);

  return raw.map((item) => ({
    subject: item.subject,
    avgDailyHours: Number(
      ((item.totalMinutes || 0) / 60 / rangeDays).toFixed(2),
    ),
    avgQuizScore: Number(item.avgQuizScore || 0),
  }));
};

const getWeeklyActivityTrend = async ({ studentIds = [], courseIds = [] }) => {
  if (!studentIds.length) return [];

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - 6);
  startDate.setHours(0, 0, 0, 0);

  const match = {
    student: { $in: studentIds },
    lastUpdated: { $gte: startDate, $lte: now },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  // Get all records for the week
  const records = await Progress.find(match).lean();

  // Calculate minutes per day using Flutter's logic
  const dayMinutes = new Map();

  for (const record of records) {
    const date = record.lastUpdated.toISOString().slice(0, 10);

    // Calculate minutes for this record using Flutter's logic
    const minutes = record.activityMinutes || 0;
    const activityType = record.activityType?.toLowerCase() || "";

    let recordMinutes = 0;
    if (minutes > 0 && minutes !== 30) {
      recordMinutes = minutes;
    } else {
      if (["quiz", "independent", "guided_practice"].includes(activityType)) {
        recordMinutes = 20;
      } else {
        recordMinutes = 2;
      }
    }

    // Add to day's total
    if (!dayMinutes.has(date)) {
      dayMinutes.set(date, 0);
    }
    dayMinutes.set(date, dayMinutes.get(date) + recordMinutes);
  }

  // Build response with 7 days
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [];

  for (let i = 6; i >= 0; i -= 1) {
    const dateObj = new Date(now);
    dateObj.setDate(now.getDate() - i);
    const iso = dateObj.toISOString().slice(0, 10);

    const totalMinutes = dayMinutes.get(iso) || 0;
    const totalHours = totalMinutes / 60;

    days.push({
      label: dayLabels[dateObj.getDay()],
      date: iso,
      total: Number(totalHours.toFixed(2)), // Total hours for that day
    });
  }

  return days;
};

const getMonthlyActivityTrend = async ({
  studentIds = [],
  courseIds = [],
  gradeLevel = null,
}) => {
  if (!studentIds.length)
    return { months: [], totals: { avgDailyHours: 0, avgQuizScore: 0 } };

  const now = new Date();
  const startDate = new Date(now.getFullYear(), 0, 1);
  const match = {
    student: { $in: studentIds },
    lastUpdated: { $gte: startDate, $lte: now },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  const normalizedGradeLevel = getOverviewGradeLevel(gradeLevel);
  if (normalizedGradeLevel) {
    match.gradeName = normalizedGradeLevel;
  }

  // Get all records for the year
  const records = await Progress.find(match).lean();

  const monthLabels = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const months = [];

  for (let i = 0; i < 12; i++) {
    const monthDate = new Date(now.getFullYear(), i, 1);
    const monthStart = new Date(now.getFullYear(), i, 1);
    const monthEnd = new Date(now.getFullYear(), i + 1, 0);
    const daysInMonth = monthEnd.getDate();

    // Filter records for this month
    const monthRecords = records.filter((record) => {
      const recordDate = new Date(record.lastUpdated);
      return recordDate >= monthStart && recordDate <= monthEnd;
    });

    // Calculate total minutes for this month using Flutter's logic
    let totalMinutes = 0;
    let totalQuizPercentage = 0;
    let quizCount = 0;

    for (const record of monthRecords) {
      const minutes = record.activityMinutes || 0;
      const activityType = record.activityType?.toLowerCase() || "";

      if (minutes > 0 && minutes !== 30) {
        totalMinutes += minutes;
      } else {
        if (["quiz", "independent", "guided_practice"].includes(activityType)) {
          totalMinutes += 20;
        } else {
          totalMinutes += 2;
        }
      }

      if (
        activityType === "quiz" &&
        record.score !== null &&
        record.score !== undefined &&
        record.totalQuestions &&
        record.totalQuestions > 0
      ) {
        totalQuizPercentage += (record.score / record.totalQuestions) * 100;
        quizCount++;
      }
    }

    const totalHours = totalMinutes / 60;
    const avgDailyHours = totalHours / daysInMonth;
    const avgQuizScore = quizCount > 0 ? totalQuizPercentage / quizCount : 0;

    months.push({
      label: monthLabels[i],
      key: `${monthDate.getFullYear()}-${String(i + 1).padStart(2, "0")}`,
      avgDailyHours: Number(avgDailyHours.toFixed(2)),
      avgQuizScore: Number(avgQuizScore.toFixed(2)),
    });
  }

  const totals = {
    avgDailyHours: Number(
      (months.reduce((acc, m) => acc + m.avgDailyHours, 0) / 12).toFixed(2),
    ),
    avgQuizScore: Number(
      (months.reduce((acc, m) => acc + m.avgQuizScore, 0) / 12).toFixed(2),
    ),
  };

  return { months, totals };
};

const getTeacherRecentWork = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range,
  limit = 10,
}) => {
  if (!studentId) return [];

  const match = buildStudentProgressMatch({
    studentId,
    courseIds,
    gradeLevel,
    range,
  });

  // Get all records
  const records = await Progress.find(match).lean();

  // Group by course
  const courseMap = new Map();

  for (const record of records) {
    const courseId = record.course?.toString();
    if (!courseId) continue;

    if (!courseMap.has(courseId)) {
      courseMap.set(courseId, {
        courseId,
        courseName: record.courseName,
        latestOverall: null,
        latestPractice: null,
        latestQuiz: null,
      });
    }

    const data = courseMap.get(courseId);

    // Track latest overall
    if (
      !data.latestOverall ||
      new Date(record.lastUpdated) > new Date(data.latestOverall.lastUpdated)
    ) {
      data.latestOverall = record;
    }

    // Track latest practice (independent)
    if (record.activityType === "independent") {
      if (
        !data.latestPractice ||
        new Date(record.lastUpdated) > new Date(data.latestPractice.lastUpdated)
      ) {
        data.latestPractice = record;
      }
    }

    // Track latest quiz
    if (record.activityType === "quiz") {
      if (
        !data.latestQuiz ||
        new Date(record.lastUpdated) > new Date(data.latestQuiz.lastUpdated)
      ) {
        data.latestQuiz = record;
      }
    }
  }

  // Get course names
  const courseIdsList = [...courseMap.keys()];
  const courses = await Course.find({ _id: { $in: courseIdsList } }).lean();
  const courseNameMap = new Map(courses.map((c) => [c._id.toString(), c.name]));

  // Build result
  const result = [];
  for (const [courseId, data] of courseMap.entries()) {
    const overall = data.latestOverall;
    if (!overall) continue;

    const courseName =
      courseNameMap.get(courseId) || data.courseName || "Unknown";

    result.push({
      subject: courseName,
      date: overall.lastUpdated,
      activityType: overall.activityType,
      score: overall.score !== undefined ? Number(overall.score) : null,
      practiceScore:
        data.latestPractice?.score !== undefined
          ? Number(data.latestPractice.score)
          : null,
      quizScore:
        data.latestQuiz?.score !== undefined
          ? Number(data.latestQuiz.score)
          : null,
      lesson: {
        strand: overall.strandName,
        subStrand: overall.subStrandName,
        lessonNumber: overall.lessonNumber,
        title: overall.lessonId,
      },
    });
  }

  // Sort by date descending and limit
  result.sort((a, b) => new Date(b.date) - new Date(a.date));
  return result.slice(0, limit);
};

const getQuizScoreTable = async ({
  studentId,
  courseIds = [],
  gradeLevel = null,
  range = null,
}) => {
  const match = {
    student: studentId,
    activityType: "quiz",
    status: "completed",
    score: { $ne: null },
    originalScore: { $ne: null },
    totalQuestions: { $ne: null, $gt: 0 },
  };

  if (courseIds.length) {
    match.course = { $in: courseIds };
  }

  const normalizedGradeLevel = getOverviewGradeLevel(gradeLevel);
  if (normalizedGradeLevel) {
    match.gradeName = normalizedGradeLevel;
  }

  if (range) {
    match.lastUpdated = { $gte: range.start, $lte: range.end };
  }

  const records = await Progress.find(match).lean();

  // Group by course
  const courseMap = new Map();

  for (const record of records) {
    const courseId = record.course?.toString();
    if (!courseId) continue;

    if (!courseMap.has(courseId)) {
      courseMap.set(courseId, {
        firstAttemptScores: [],
        latestAttemptScores: [],
      });
    }

    const data = courseMap.get(courseId);

    // First attempt (originalScore)
    if (record.originalScore !== null && record.totalQuestions) {
      const percent = (record.originalScore / record.totalQuestions) * 100;
      data.firstAttemptScores.push(percent);
    }

    // Latest attempt (score)
    if (record.score !== null && record.totalQuestions) {
      const percent = (record.score / record.totalQuestions) * 100;
      data.latestAttemptScores.push(percent);
    }
  }

  // Get course names
  const courses = await Course.find({
    _id: { $in: [...courseMap.keys()] },
  }).lean();
  const courseNameMap = new Map(courses.map((c) => [c._id.toString(), c.name]));

  const result = [];
  for (const [courseId, data] of courseMap.entries()) {
    const avgFirst =
      data.firstAttemptScores.length > 0
        ? data.firstAttemptScores.reduce((a, b) => a + b, 0) /
          data.firstAttemptScores.length
        : 0;
    const avgLatest =
      data.latestAttemptScores.length > 0
        ? data.latestAttemptScores.reduce((a, b) => a + b, 0) /
          data.latestAttemptScores.length
        : 0;

    result.push({
      subject: courseNameMap.get(courseId) || "Unknown",
      avgFirstAttempt: Number(avgFirst.toFixed(1)),
      avgLatestAttempt: Number(avgLatest.toFixed(1)),
    });
  }

  return result.sort((a, b) => a.subject.localeCompare(b.subject));
};

export const getTeacherDashboard = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const gradeLevel = req.query.gradeLevel || "ALL";
  const timePeriod = req.query.timePeriod || "Past Year";
  const subject = req.query.subject || "ALL";

  // Build student filter based on gradeLevel (for totalStudents count)
  const studentFilter = { school: teacher.school?._id };
  const normalizedGradeLevel = getGradeLevelFilter(gradeLevel);
  if (normalizedGradeLevel) {
    studentFilter.gradeLevel = normalizedGradeLevel;
  }

  // Get filtered students (for charts and filtered counts)
  const filteredStudents = await Student.find(studentFilter)
    .populate("user", "userId lastLoginAt")
    .lean();
  const filteredStudentIds = filteredStudents.map((student) => student._id);

  // Get ALL students (for counters that should show overall data)
  const allStudents = await Student.find({ school: teacher.school?._id })
    .populate("user", "userId lastLoginAt")
    .lean();
  const allStudentIds = allStudents.map((student) => student._id);

  // Get course IDs based on subject filter (for charts)
  const courseIds = resolveTeacherCourseIds(teacher.courses || [], subject);
  const selectedCourseIds =
    isAllFilter(subject) || courseIds.length ? courseIds : ["__no_match__"];

  // Get date range for timePeriod filter (for charts)
  const dateRange = getDateRangeFromPeriod(timePeriod);

  // ========== COUNTERS (USE OVERALL DATA, NO FILTERS) ==========
  const totalStudentsCount = allStudents.length;

  // Login counts based on ALL students (no gradeLevel filter)
  const loginCounts = buildStudentStatusCounts(allStudents);

  // Overall progress counts (no filters)
  const overallProgressMatch = {
    student: { $in: allStudentIds },
    status: "completed",
  };

  const [totalCompleted, totalQuizCompleted] = await Promise.all([
    Progress.countDocuments(overallProgressMatch),
    Progress.countDocuments({ ...overallProgressMatch, activityType: "quiz" }),
  ]);

  // ========== CHARTS (USE FILTERS) ==========
  const [subjectOverview, subjectMetrics, weeklyStudents] = await Promise.all([
    getCompletionTrend({
      studentIds: filteredStudentIds,
      courseIds: selectedCourseIds,
      range: dateRange,
    }),
    getSubjectPerformanceSeries({
      studentIds: filteredStudentIds,
      courseIds: selectedCourseIds,
      range: dateRange,
    }),
    getWeeklyActivityTrend({
      studentIds: filteredStudentIds,
      courseIds: selectedCourseIds,
    }),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Teacher dashboard fetched successfully",
    data: {
      teacher: {
        _id: teacher._id,
        name: teacher.name,
        school: teacher.school,
        gradeLevel: teacher.gradeLevel,
      },
      filters: {
        gradeLevel,
        timePeriod,
        subject,
        gradeLevels: ["JHS1", "JHS2", "JHS3", "ALL"],
        timePeriods: [
          "Today",
          "Past Week",
          "Past 1 Month",
          "Past 3 Months",
          "Past 6 Months",
          "Past Year",
        ],
        subjects: [
          "English",
          "Science",
          "Social Science",
          "Religious and Moral Education",
          "Math",
          "ALL",
        ],
      },
      counters: {
        totalStudents: totalStudentsCount,
        activeStudents: loginCounts.active,
        inactiveStudents: loginCounts.inactive,
        totalSubjects: teacher.courses?.length || subjectMetrics.length || 0,
        lessonCompleted: totalCompleted,
        quizCompleted: totalQuizCompleted,
      },
      charts: {
        subjectOverview,
        subjectMetrics,
        weeklyStudents,
      },
    },
  });
});

export const getTeacherStudents = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const { page, limit, skip } = parsePagination(req.query);
  const filter = { school: teacher.school?._id };
  const gradeLevel = req.query.gradeLevel || "ALL";

  // Sorting parameters
  const sortBy = req.query.sortBy || "createdAt";
  const sortOrder = req.query.sortOrder || "desc";
  const sortDirection = sortOrder === "asc" ? 1 : -1;

  if (req.query.status) filter.status = req.query.status;
  const normalizedGradeLevel = getGradeLevelFilter(gradeLevel);
  if (normalizedGradeLevel) filter.gradeLevel = normalizedGradeLevel;

  if (req.query.search) {
    const regex = buildSearchRegex(req.query.search);
    const users = await User.find(
      { role: "student", $or: [{ name: regex }, { userId: regex }] },
      { _id: 1 },
    );
    filter.$or = [{ name: regex }];
    if (users.length)
      filter.$or.push({ user: { $in: users.map((u) => u._id) } });
  }

  // Build sort object for MongoDB
  let sortObject = {};
  let needsClientSideSorting = false;

  switch (sortBy) {
    case "studentName":
      sortObject = { name: sortDirection };
      break;
    case "userId":
      sortObject = { "user.userId": sortDirection };
      break;
    case "gradeLevel":
      sortObject = { gradeLevel: sortDirection };
      break;
    case "status":
      sortObject = { "user.lastLoginAt": sortDirection };
      break;
    case "lastLoginAt":
      sortObject = { "user.lastLoginAt": sortDirection };
      break;
    case "avgQuizScore":
      // avgQuizScore is calculated in JavaScript, so we need client-side sorting
      needsClientSideSorting = true;
      sortObject = { createdAt: -1 }; // Default fallback
      break;
    case "createdAt":
    default:
      sortObject = { createdAt: sortDirection };
      break;
  }

  // Fetch students with pagination
  let items = [];
  let total = 0;

  if (needsClientSideSorting) {
    // For avgQuizScore, fetch all items for current page first, then sort in JS
    const [fetchedItems, totalCount] = await Promise.all([
      Student.find(filter)
        .populate("school", "name schoolCode")
        .populate("user", "userId lastLoginAt")
        .skip(skip)
        .limit(limit)
        .lean(),
      Student.countDocuments(filter),
    ]);
    items = fetchedItems;
    total = totalCount;
  } else {
    // Normal sorting in MongoDB
    const [fetchedItems, totalCount] = await Promise.all([
      Student.find(filter)
        .populate("school", "name schoolCode")
        .populate("user", "userId lastLoginAt")
        .sort(sortObject)
        .skip(skip)
        .limit(limit)
        .lean(),
      Student.countDocuments(filter),
    ]);
    items = fetchedItems;
    total = totalCount;
  }

  // Get all progress records for these students to calculate avgQuizScore
  const studentIds = items.map((item) => item._id);

  // Get all quiz records for these students
  const quizRecords = await Progress.find({
    student: { $in: studentIds },
    activityType: "quiz",
    status: "completed",
    score: { $ne: null },
    totalQuestions: { $ne: null, $gt: 0 },
  }).lean();

  // Group quiz scores by student and calculate average percentage
  const studentQuizScores = new Map();

  for (const record of quizRecords) {
    const studentId = record.student.toString();
    const percentage = (record.score / record.totalQuestions) * 100;

    if (!studentQuizScores.has(studentId)) {
      studentQuizScores.set(studentId, []);
    }
    studentQuizScores.get(studentId).push(percentage);
  }

  // Calculate average quiz score for each student
  const studentAvgQuizScores = new Map();
  for (const [studentId, scores] of studentQuizScores.entries()) {
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    studentAvgQuizScores.set(studentId, Number(avgScore.toFixed(1)));
  }

  // Map items with avgQuizScore
  let mappedItems = items.map((item) => ({
    _id: item._id,
    studentName: item.name,
    userId: item.user?.userId,
    schoolName: item.school?.name,
    gradeLevel: item.gradeLevel,
    status: getStudentLoginStatus(item.user?.lastLoginAt),
    lastLoginAt: item.user?.lastLoginAt || null,
    avgQuizScore: studentAvgQuizScores.get(item._id.toString()) || 0,
  }));

  // If sorting by avgQuizScore, do client-side sorting
  if (needsClientSideSorting) {
    mappedItems.sort((a, b) => {
      const aScore = a.avgQuizScore || 0;
      const bScore = b.avgQuizScore || 0;
      return sortDirection === 1 ? aScore - bScore : bScore - aScore;
    });
  }

  // Handle status sorting if needed (fallback for when MongoDB sort didn't work as expected)
  if (sortBy === "status" && !needsClientSideSorting) {
    const statusOrder = {
      active: 0,
      inactive: 1,
    };
    if (sortDirection === 1) {
      mappedItems.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
    } else {
      mappedItems.sort((a, b) => statusOrder[b.status] - statusOrder[a.status]);
    }
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Students fetched successfully",
    data: {
      items: mappedItems,
      meta: getPaginationMeta({ page, limit, total }),
      // Include available sort options for frontend
      sortOptions: {
        fields: [
          { value: "studentName", label: "Name" },
          { value: "userId", label: "User ID" },
          { value: "gradeLevel", label: "Grade Level" },
          { value: "status", label: "Status" },
          { value: "lastLoginAt", label: "Last Login" },
          { value: "avgQuizScore", label: "Average Quiz Score" },
          { value: "createdAt", label: "Created Date" },
        ],
        default: "createdAt",
        defaultOrder: "desc",
      },
    },
  });
});

export const getTeacherStudentById = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const student = await Student.findOne({
    _id: req.params.studentId,
    school: teacher.school?._id,
  })
    .populate("school", "name schoolCode")
    .populate("user", "name userId lastLoginAt")
    .lean();

  if (!student) return next(new AppError(404, "Student not found"));

  const progressSheet = await getStudentProgressSummary({
    studentId: student._id,
  });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student details fetched successfully",
    data: {
      student: {
        _id: student._id,
        studentName: student.name,
        userId: student.user?.userId,
        schoolName: student.school?.name,
        schoolCode: student.school?.schoolCode,
        gradeLevel: student.gradeLevel,
        status: getStudentLoginStatus(student.user?.lastLoginAt),
        lastLoginAt: student.user?.lastLoginAt || null,
      },
      progressSheet,
    },
  });
});

export const getTeacherStudentOverview = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  const gradeLevel = req.query.gradeLevel || "ALL";
  const subject = req.query.subject || "ALL";
  const timePeriod = req.query.timePeriod || "Today";
  const { courseId } = req.query;

  // Get all course IDs for the teacher (for quizScoreTable - subject filter ignored)
  const allTeacherCourseIds = teacher.courses?.map((c) => c._id) || [];

  // Get course IDs filtered by subject (for other parts)
  const allowedCourseIds = resolveTeacherCourseIds(
    teacher.courses || [],
    subject,
  );

  let selectedCourseIds = allowedCourseIds;
  if (courseId) {
    const hasCourse = (teacher.courses || []).some(
      (c) => String(c._id) === String(courseId),
    );
    if (!hasCourse) {
      return next(new AppError(403, "Course not assigned to this teacher"));
    }
    selectedCourseIds = [courseId];
  }

  const student = await Student.findOne({
    _id: req.params.studentId,
    school: teacher.school?._id,
  })
    .populate("school", "name schoolCode")
    .populate("user", "name userId status lastLoginAt")
    .lean();

  if (!student) return next(new AppError(404, "Student not found"));

  const recentRange = getDateRangeFromPeriod(timePeriod);
  const effectiveGradeLevel = getOverviewGradeLevel(gradeLevel);
  const matchBase = buildStudentProgressMatch({
    studentId: student._id,
    courseIds: selectedCourseIds,
    gradeLevel: effectiveGradeLevel,
    range: recentRange,
  });

  const [
    progressSheet,
    courseWiseOverview,
    monthlyActivity,
    recentWork,
    activityBreakdown,
    quizScoreTable,
  ] = await Promise.all([
    getStudentProgressSummary({
      studentId: student._id,
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: recentRange,
      timePeriod,
    }),
    getCourseWiseOverview({
      studentId: student._id,
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: recentRange,
      timePeriod,
    }),
    getMonthlyActivityTrend({
      studentIds: [student._id],
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
    }),
    getTeacherRecentWork({
      studentId: student._id,
      courseIds: selectedCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: null,
    }),
    Progress.aggregate([
      { $match: matchBase },
      {
        $group: {
          _id: "$activityType",
          total: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          _id: 0,
          activityType: "$_id",
          total: 1,
          completed: 1,
        },
      },
    ]),
    // New: Quiz Score Table (ignores subject filter)
    getQuizScoreTable({
      studentId: student._id,
      courseIds: allTeacherCourseIds,
      gradeLevel: effectiveGradeLevel,
      range: recentRange,
    }),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Student overview fetched successfully",
    data: {
      student: {
        _id: student._id,
        studentName: student.name,
        userId: student.user?.userId,
        schoolName: student.school?.name,
        schoolCode: student.school?.schoolCode,
        gradeLevel: student.gradeLevel,
        status: getStudentLoginStatus(student.user?.lastLoginAt),
        lastLoginAt: student.user?.lastLoginAt || null,
        picture: student.picture,
      },
      filters: {
        gradeLevel,
        timePeriod,
        subject,
        gradeLevels: ["JHS1", "JHS2", "JHS3", "ALL"],
        timePeriods: [
          "Today",
          "Past Week",
          "Past 1 Month",
          "Past 3 Months",
          "Past 6 Months",
          "Past Year",
        ],
        subjects: [
          "English",
          "Science",
          "Social Science",
          "Religious and Moral Education",
          "Math",
          "ALL",
        ],
      },
      overview: {
        summary: progressSheet.summary,
        subjectProgress: progressSheet.subjectProgress,
        courseWiseOverview,
        monthlyActivity,
        activityBreakdown,
        recentWork,
        quizScoreTable, // New field
      },
    },
  });
});

export const getTeacherSubjects = catchAsync(async (req, res, next) => {
  const teacher = await getTeacherDoc(req.user._id);
  if (!teacher) return next(new AppError(404, "Teacher profile not found"));

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Subjects fetched successfully",
    data: teacher.courses || [],
  });
});

export const getTeacherPrivacyPolicy = catchAsync(async (req, res) => {
  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Privacy policy fetched successfully",
    data: {
      title: "Privacy Policy",
      content:
        "Control who can see your progress. We collect only the data needed to provide lesson progress, quiz performance, and support services.",
    },
  });
});

export const createTeacherSupportTicket = catchAsync(async (req, res, next) => {
  const { subject, description } = req.body;

  if (!subject || !description) {
    return next(new AppError(400, "subject and description are required"));
  }

  const ticket = await SupportTicket.create({
    user: req.user._id,
    role: "teacher",
    userId: req.user.userId || "",
    subject,
    description,
  });

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: "Support ticket created successfully",
    data: ticket,
  });
});

export const getTeacherProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  const teacher = await getTeacherDoc(req.user._id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile fetched successfully",
    data: {
      user,
      teacher,
    },
  });
});

export const updateTeacherProfile = catchAsync(async (req, res, next) => {
  const userPayload = {};
  const teacherPayload = {};
  for (const key of ["firstName", "lastName", "phone", "bio"]) {
    if (req.body[key] !== undefined) {
      userPayload[key] = req.body[key];
      teacherPayload[key] = req.body[key];
    }
  }

  const teacherDoc = await Teacher.findOne({ user: req.user._id });
  if (!teacherDoc) {
    return next(new AppError(404, "Teacher profile not found"));
  }

  if (req.files?.picture?.[0]) {
    const upload = await uploadOnCloudinary(
      req.files.picture[0].buffer,
      "profiles",
    );
    teacherPayload.picture = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  if (req.files?.file?.[0]) {
    const upload = await uploadOnCloudinary(req.files.file[0].buffer, "files");
    teacherPayload.file = {
      url: upload.secure_url,
      public_id: upload.public_id,
    };
  }

  const [user, teacher] = await Promise.all([
    User.findByIdAndUpdate(req.user._id, userPayload, {
      new: true,
    }),
    Teacher.findOneAndUpdate(
      { user: req.user._id },
      { $set: teacherPayload },
      { new: true },
    ),
  ]);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Profile updated successfully",
    data: { user, teacher },
  });
});

export const changeTeacherPassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return next(
      new AppError(
        400,
        "currentPassword, newPassword and confirmPassword are required",
      ),
    );
  }

  if (newPassword !== confirmPassword) {
    return next(new AppError(400, "Passwords do not match"));
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!user) return next(new AppError(404, "User not found"));

  const matched = await User.isPasswordMatched(currentPassword, user.password);
  if (!matched) return next(new AppError(400, "Current password is incorrect"));

  user.password = newPassword;
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Password changed successfully",
  });
});

export const getTeacherCourseCatalog = catchAsync(async (req, res) => {
  const courses = await Course.find({ status: "active" }).sort({ name: 1 });

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Course catalog fetched successfully",
    data: courses,
  });
});
