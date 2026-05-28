import type { ObjectId } from 'mongodb';

export type User = {
  _id: ObjectId;
  email: string;
  name: string;
  avatarUrl?: string;
  provider: 'google' | 'dev';
  createdAt: Date;
  updatedAt: Date;
};

export type StudySession = {
  _id: ObjectId;
  userId: ObjectId;
  subjectId?: string;
  timerMode?: 'basic' | 'pomodoro';
  pomodoroFocusMinutes?: number;
  pomodoroBreakMinutes?: number;
  status: 'running' | 'paused' | 'stopped';
  startedAt: Date;
  lastStartedAt: Date;
  stoppedAt?: Date;
  durationSeconds?: number;
  stopReason?: string;
  accumulatedSeconds: number;
  lastLatitude: number;
  lastLongitude: number;
  lastRecordedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type Subject = {
  _id: ObjectId;
  userId: ObjectId;
  subjectId: string;
  label: string;
  color?: string;
  icon?: string;
  isActive?: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
};

export type Goal = {
  _id: ObjectId;
  userId: ObjectId;
  goalId: string;
  title: string;
  targetSeconds: number;
  period: 'weekly' | 'monthly';
  order: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TimerPreferences = {
  _id: ObjectId;
  userId: ObjectId;
  pomodoroFocusMinutes: number;
  pomodoroBreakMinutes: number;
  pomodoroLongBreakMinutes?: number;
  pomodoroLongBreakInterval?: number;
  pomodoroAlarmOn?: boolean;
  pomodoroFocusWhiteNoise?: string;
  pomodoroBreakWhiteNoise?: string;
  pomodoroFocusWhiteNoiseVolume?: number;
  pomodoroBreakWhiteNoiseVolume?: number;
  whiteNoiseVolume?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type LoginSession = {
  _id: ObjectId;
  userId: ObjectId;
  deviceId: string;
  deviceName: string;
  deviceType: 'smartphone' | 'tablet' | 'web' | string;
  platform: string;
  userAgent: string;
  browserName?: string | null;
  browserVersion?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  ipAddress?: string | null;
  regionName?: string | null;
  cityName?: string | null;
  districtName?: string | null;
  countryName?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isActive: boolean;
  lastLogin: Date;
  lastSeenAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
