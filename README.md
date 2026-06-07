# MoveMate AI

> **A free, browser-based AI personal trainer that watches you work out, counts your reps, corrects your form in real time, and builds a personalised workout plan — no gym, no equipment, no subscription required.**

Built for the **Walter Payton College Prep Coding Club — Health and Fitness Technology Hackathon 2026**.

---

## Table of Contents

- [What It Does](#what-it-does)
- [The Problem We Are Solving](#the-problem-we-are-solving)
- [How The AI Works](#how-the-ai-works)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Quick Start — Local Dev (No Docker)](#quick-start--local-dev-no-docker)
- [Running With Docker](#running-with-docker)
- [Environment Variables](#environment-variables)
- [Exercises Supported](#exercises-supported)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Known Limitations](#known-limitations)

---

## What It Does

1. **Register** and set your fitness goal — weight, target, timeline
2. **AI generates** a full personalised week-by-week workout roadmap for your body
3. **Dashboard** shows today's workout, calories burned this week, streak, and form score
4. **Click Start Workout** → pick an exercise → click **Start AI Webcam Workout**
5. Your webcam opens in the browser — MediaPipe AI tracks your body at ~30 fps
6. A **green skeleton overlay** appears on your body showing every joint being tracked
7. AI **counts reps automatically** using real joint angle mathematics
8. **Live form feedback** appears on screen — "Go lower", "Keep chest up", "Straighten body"
9. **Form score** updates every frame — 0 to 100%
10. Results **auto-save** after every set — reps, calories, form score, posture events
11. **Workout Results page** shows full breakdown of your session

---

## The Problem We Are Solving

Most people who want to get fit face three problems:

- **Personal trainers are unaffordable.** A single session costs $50–$150. Most teenagers simply cannot access proper coaching.
- **Generic apps do not personalise.** They give everyone the same plan regardless of your body, goal, or fitness level.
- **Nobody watches your form at home.** Bad form during squats, push-ups and lunges is the number one cause of injury for beginners. You can spend months doing exercises wrong and making things worse.

MoveMate AI solves all three. It is a personal trainer that runs entirely in your browser, watches your form through your webcam, and builds a plan specifically for you — completely free.

---

## How The AI Works

MoveMate AI uses **Google MediaPipe Pose Landmarker** running as WebAssembly directly in the browser. This means:

- The AI runs **100% on your device** — your webcam video is never uploaded anywhere
- Works on any laptop or desktop with a webcam
- No app install, no Python environment needed for workouts

The pose model detects **33 body landmarks** (joints and key points) at ~30 frames per second. Our custom exercise logic then:

1. Calculates **joint angles** using trigonometry (e.g. knee angle for squats, elbow angle for push-ups)
2. Runs a **state machine** — tracking DOWN → UP transitions with strict angle thresholds
3. Applies **position gates** — push-ups only count when lying flat (blocks counting when standing), sit-ups only count when lying on the floor with bent knees
4. Requires a **minimum hold time** at the bottom position — eliminates micro-movement false counts
5. Enforces an **800ms cooldown** between reps — prevents double-counting on fast movements

---

## Architecture

```
Browser (localhost:5173 or port 80 in prod)
  │
  ├── REST API calls ──────────────────► Django backend (port 8000)
  │   /api/users/  /api/fitness/           Auth, plans, sessions, results
  │
  ├── WebAssembly pose detection
  │     Runs 100% in browser via MediaPipe Tasks Vision
  │     No server involved during the workout itself
  │
  └── Canvas overlay
        Video feed + green skeleton + HUD drawn on <canvas>

PostgreSQL database  ◄──  Django ORM

Optional: FastAPI AI service (port 9001)
  Python/OpenCV legacy mode — only needed if using the
  old local desktop window instead of the browser webcam
```

**Services:**

| Service | Port | Purpose |
|---|---|---|
| Django backend | 8000 | Auth, plan generation, saving results, dashboard data |
| React + Vite frontend | 5173 (dev) / 80 (prod) | UI, browser webcam AI workout |
| PostgreSQL | 5432 | Main database |
| FastAPI AI service | 9001 | Optional — legacy Python/OpenCV mode |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 8, React Router v7, Lucide React |
| Pose detection | MediaPipe Tasks Vision 0.10.35 (WASM, runs in browser) |
| Exercise logic | Custom JS — joint angles, state machines, form scoring |
| Backend | Django 6, Django REST Framework 3.17 |
| Auth | SimpleJWT — HttpOnly cookie access + refresh tokens |
| Database | PostgreSQL 16 |
| API docs | drf-spectacular (Swagger UI) |
| AI service (optional) | FastAPI 0.115, Uvicorn, OpenCV, MediaPipe Python |
| Containerisation | Docker (multi-stage builds), Docker Compose |
| Web server (prod) | Nginx 1.27 — serves React build, proxies `/api` to Django |

---

## Prerequisites

### Without Docker

- Python 3.12+
- Node.js 20+
- PostgreSQL 14+ running locally
- A webcam

### With Docker

- Docker Desktop (Windows / Mac) or Docker Engine + Docker Compose plugin (Linux)
- A webcam accessible to the browser

---

## Quick Start — Local Dev (No Docker)

Three terminals required.

### Terminal 1 — Python environment

```bash
# From project root
python -m venv venv

# Mac / Linux
source venv/bin/activate

# Windows
venv\Scripts\activate

pip install -r requirements.txt
```

### Terminal 2 — Django backend

```bash
cd backend

# Copy and edit environment variables
cp ../.env.example ../.env

python manage.py migrate
python manage.py seed_exercises
python manage.py runserver
```

Backend: **http://localhost:8000**
Swagger docs: **http://localhost:8000/api/docs/**

> Create a superuser for the admin panel (optional):
> ```bash
> python manage.py createsuperuser
> ```

### Terminal 3 — React frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend: **http://localhost:5173**

> ⚠️ Always use `localhost:5173` — **not** `127.0.0.1:5173`.
> Some browsers block webcam access on `127.0.0.1`. The MediaPipe WASM
> security headers (COOP/COEP) require `localhost` to work correctly.

### Terminal 4 — FastAPI AI service (optional)

Only needed for the legacy Python/OpenCV desktop window.
The browser webcam workout works without it.

```bash
# From project root (venv active)
uvicorn ai_model.api_server:app --host 127.0.0.1 --port 9001 --reload
```

### URLs at a glance

| URL | What it is |
|---|---|
| http://localhost:5173 | The app |
| http://localhost:8000/api/docs/ | Swagger API docs |
| http://localhost:8000/admin/ | Django admin panel |

---

## Running With Docker

### Development (live reload)

```bash
# From project root — copies .env.example to .env first if needed
cp .env.example .env

docker compose up --build
```

Starts:
- `movemate_db` — PostgreSQL on port 5432
- `movemate_backend` — Django dev server on port 8000 (source mounted for live reload)
- `movemate_frontend` — Vite dev server on port 5173 (source mounted for live reload)

The AI service uses the `ai` profile — start it only if needed:

```bash
docker compose --profile ai up --build
```

Open **http://localhost:5173**

### Production

Production uses Gunicorn for Django and Nginx to serve the React build.

**Step 1 — Configure your `.env`:**

```bash
SECRET_KEY=your-very-long-random-secret-key-here
DEBUG=0
DJANGO_ALLOWED_HOSTS=yourdomain.com
CORS_ALLOWED_ORIGINS=https://yourdomain.com

POSTGRES_DB=movemate
POSTGRES_USER=movemate
POSTGRES_PASSWORD=your-strong-password

VITE_API_URL=https://yourdomain.com/api
VITE_AI_SERVICE_URL=https://yourdomain.com:9001
```

**Step 2 — Build and start:**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

What runs in production:
- Django under **Gunicorn** with 4 workers
- React **pre-built** and served by **Nginx** on port 80
- Nginx proxies `/api/` to the Django container
- PostgreSQL exposed only on the internal Docker network (not publicly)

**Stop:**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```

### Useful Docker commands

```bash
# Follow logs
docker compose logs -f backend
docker compose logs -f frontend

# Run migrations inside container
docker compose exec backend python manage.py migrate

# Seed exercises into database
docker compose exec backend python manage.py seed_exercises

# Create admin user
docker compose exec backend python manage.py createsuperuser

# Rebuild one service
docker compose up --build backend

# Wipe everything including the database volume
docker compose down -v
```

---

## Environment Variables

All variables live in `.env` at the project root. Copy `.env.example` to get started.

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | `dev-secret-key-...` | Django secret key — **must change in production** |
| `DEBUG` | `1` | Set to `0` in production |
| `DJANGO_ALLOWED_HOSTS` | `localhost 127.0.0.1 backend` | Space-separated allowed hosts |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173,...` | Comma-separated frontend origins |
| `POSTGRES_DB` | `movemate` | PostgreSQL database name |
| `POSTGRES_USER` | `movemate` | PostgreSQL username |
| `POSTGRES_PASSWORD` | *(required)* | PostgreSQL password |
| `POSTGRES_HOST` | `db` | PostgreSQL host (Docker service name) |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `VITE_API_URL` | `http://localhost:8000/api` | Backend API URL (used at frontend build time) |
| `VITE_AI_SERVICE_URL` | `http://localhost:9001` | FastAPI AI service URL |

### JWT settings (`backend/backend/settings.py`)

```python
SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME":    timedelta(minutes=15),
    "REFRESH_TOKEN_LIFETIME":   timedelta(days=7),
    "ROTATE_REFRESH_TOKENS":    True,
    "BLACKLIST_AFTER_ROTATION": True,
}
JWT_COOKIE_SECURE   = False   # set True in production (HTTPS only)
JWT_COOKIE_SAMESITE = "Lax"
```

---

## Exercises Supported

All exercises use the browser webcam with MediaPipe. No setup required.

| Exercise | Slug | Rep detection method | Camera |
|---|---|---|---|
| Squat | `squat` | Knee angle avg: DOWN ≤ 105° → UP ≥ 160° | Front |
| Push-up | `push_up` | Elbow angle: DOWN ≤ 95° → UP ≥ 155° + prone position gate | Side |
| Sit-up | `sit_up` | Torso angle: DOWN 90–140° → UP < 55° + lying flat gate | Side |
| Jumping Jack | `jumping_jack` | Foot ratio + wrist height CLOSED ↔ OPEN | Front |
| Plank | `plank` | 3s countdown → hold timer. Alarm + red flash on form break | Side |
| Lunge | `lunges` | Front knee < 115° → both knees > 155° | Front |
| Burpee | `burpee` | Floor position (knee ≤ 115°) → wrists above shoulders | Front |
| Mountain Climber | `mountain_climber` | Alternating knee drives, L + R = 1 rep | Side |

### Camera positioning

- **Side view** (push-up, sit-up, plank, mountain climber) — stand or lie sideways so the camera sees your full body profile from the side
- **Front-facing** (squat, jumping jack, lunge, burpee) — face the camera directly, step back until your full body fits the frame
- Room must be **well-lit** — avoid backlighting from windows
- Always use **localhost** not 127.0.0.1 in your browser address bar

### Plank behaviour

1. Get into plank position
2. A **3-second countdown** appears — hold still
3. Once countdown ends the **hold timer starts**
4. Form breaks → **red flash overlay + alarm beep** → timer resets
5. Hold still for another 3 seconds to restart the timer

---

## API Reference

Full interactive docs with request/response examples at **http://localhost:8000/api/docs/**

### Auth — `/api/users/`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register/` | No | Create account |
| `POST` | `/auth/login/` | No | Login — sets `access_token` + `refresh_token` HttpOnly cookies |
| `POST` | `/auth/logout/` | Yes | Clears cookies, blacklists refresh token |
| `GET` | `/auth/me/` | Yes | Current user info |
| `POST` | `/auth/refresh/` | No | Refresh access token from cookie |

### Fitness — `/api/fitness/`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` / `PATCH` | `/profile/` | Yes | User profile — age, weight, height, activity level |
| `POST` | `/plans/generate/` | Yes | Generate personalised AI workout roadmap |
| `GET` | `/roadmaps/` | Yes | List all roadmaps |
| `GET` | `/roadmaps/{id}/` | Yes | Roadmap detail with all days and exercises |
| `GET` | `/roadmaps/today/` | Yes | Today's workout day |
| `GET` | `/dashboard/` | Yes | Calories, streak, form score, today's plan |
| `POST` | `/workout-sessions/start/` | Yes | Start a workout session |
| `GET` | `/workout-sessions/` | Yes | All past sessions |
| `GET` | `/workout-sessions/{id}/` | Yes | Session detail with exercise logs |
| `POST` | `/workout-sessions/{id}/ai-result/` | Yes | Save AI workout result from browser |
| `GET` / `POST` | `/body-metrics/` | Yes | Weight and body metric log |
| `GET` / `POST` | `/goals/` | Yes | Fitness goals |

---

## Project Structure

```
movemate-ai/
│
├── backend/                          Django project
│   ├── Dockerfile                    Multi-stage: base → development → production
│   ├── requirements.txt              Django, DRF, SimpleJWT, psycopg2, gunicorn
│   ├── manage.py
│   ├── backend/
│   │   ├── settings.py               All config — reads from environment variables
│   │   └── urls.py                   /api/users/, /api/fitness/, /api/docs/
│   ├── users/                        Auth app
│   │   ├── models.py                 Custom User — email-based login, UUID primary key
│   │   ├── authentication.py         CookieJWTAuthentication
│   │   ├── jwt.py                    set_auth_cookies / delete_auth_cookies
│   │   ├── views.py                  Register, Login, Logout, Me, Refresh
│   │   └── urls.py
│   └── fitness/                      Main app
│       ├── models.py                 UserProfile, FitnessGoal, Roadmap, RoadmapDay,
│       │                             RoadmapDayExercise, Exercise, WorkoutSession,
│       │                             ExerciseLog, DailyCalorieSummary, PostureEvent
│       ├── serializers.py
│       ├── views.py
│       ├── urls.py
│       ├── signals.py                Auto-creates UserProfile on new User
│       ├── services/
│       │   ├── plan_generator.py     Generates full week-by-week roadmap
│       │   └── calorie_calculator.py BMR + TDEE formulas
│       └── management/commands/
│           └── seed_exercises.py     Seeds 8 exercises into the database
│
├── frontend/                         React + Vite SPA
│   ├── Dockerfile                    Multi-stage: deps → development → builder → Nginx
│   ├── nginx.conf                    SPA routing, /api proxy, WASM COOP/COEP headers
│   ├── vite.config.js                Dev proxy + security headers for MediaPipe WASM
│   ├── package.json
│   └── src/
│       ├── main.jsx                  Entry point — BrowserRouter + AuthProvider
│       ├── App.jsx                   Route definitions
│       ├── api/client.js             Fetch wrapper — auto token refresh on 401
│       ├── context/AuthContext.jsx   Global auth state
│       ├── lib/exerciseLogic.js      All pose analysis — joint angles, state machines,
│       │                             form scoring for all 8 exercises
│       ├── hooks/
│       │   ├── useWebcamPose.js      MediaPipe camera hook — RAF loop, canvas drawing,
│       │   │                         skeleton overlay, HUD, rep counting
│       │   └── useSpeech.js          Voice coach — rep counting, form warnings
│       ├── components/               DashboardLayout, Sidebar, Navbar, StatCard, etc.
│       └── pages/                    Landing, Login, Register, Dashboard, LiveWorkout,
│                                     ExerciseSelection, WorkoutResults, Profile, etc.
│
├── ai_model/                         Python AI engine (optional — legacy mode)
│   ├── Dockerfile                    Multi-stage: base → development → production
│   ├── requirements_ai.txt           FastAPI, Uvicorn, OpenCV, MediaPipe, NumPy
│   ├── api_server.py                 FastAPI service (port 9001)
│   ├── workout_runner.py             OpenCV webcam set/rep loop
│   ├── exercise_logic.py             Pose analysis — all exercises
│   ├── drawing.py                    OpenCV overlay and info panel
│   ├── pose_helpers.py               Angle calculation and landmark helpers
│   ├── landmarks.py                  MediaPipe landmark index constants
│   ├── state.py                      MoveMateState dataclass
│   ├── config.py                     Angle thresholds and camera settings
│   └── pose_landmarker_lite.task     MediaPipe model file (~6 MB)
│
├── .env                              Local environment variables (not committed)
├── .env.example                      Template — copy to .env and fill in values
├── .gitignore
├── docker-compose.yml                Dev — backend + frontend + db + ai (profile)
├── docker-compose.prod.yml           Prod overrides — Gunicorn, Nginx, no source mounts
├── requirements.txt                  Full Python deps for local venv
└── README.md                         This file
```

---

## Known Limitations

- **Camera must be on `localhost`** — not `127.0.0.1`. MediaPipe WASM requires the specific COOP/COEP security headers that Vite sets on `localhost`.
- **Side-view exercises** (push-up, sit-up, plank) need the camera positioned to your side — they will not work from a front-facing angle.
- **Lighting matters** — the pose model struggles in dim rooms or with strong backlighting behind you.
- **`pose_landmarker_lite.task`** (~6 MB binary) is not committed to git. It is downloaded automatically by the browser from Google's CDN during the workout. The Python AI service needs it locally — download from [MediaPipe Models](https://developers.google.com/mediapipe/solutions/vision/pose_landmarker#models).
- **`DailyCalorieSummary`** overwrites rather than accumulates if multiple workouts are completed in one day. Known issue, not yet fixed.
- **SECRET_KEY** in `.env.example` is a placeholder — generate a real one before any public deployment: `python -c "import secrets; print(secrets.token_urlsafe(50))"`.
