# Auto ETL Tool

AI-assisted ELT pipeline builder: PostgreSQL → MySQL, zero boilerplate.

## Prerequisites
- Python 3.11+
- Node.js 18+
- A PostgreSQL source database
- A MySQL target database
- Gemini API key → https://aistudio.google.com  (free)
- Groq API key   → https://console.groq.com      (free, 14 400 req/day)

---

## 1 — Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # then fill in your API keys
uvicorn main:app --reload --port 8000
```

Swagger UI → http://localhost:8000/docs

## 2 — Frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
```

App → http://localhost:5173

## 3 — First run

1. Open http://localhost:5173
2. Click **Connect** in the left rail
3. Choose **PostgreSQL** as source → paste connection string → Test
4. Choose **MySQL** as target → paste connection string → Test
5. Select relevant source tables
6. Describe your pipeline in plain English
7. Click **Generate Pipeline**

---

## Environment variables (backend/.env)

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | From aistudio.google.com |
| `GROQ_API_KEY` | From console.groq.com |

Database connections are entered through the app UI — no DB env vars needed.
