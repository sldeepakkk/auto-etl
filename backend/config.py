from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Required — get a free key at https://console.groq.com
    GROQ_API_KEY: str = ""

    # Optional — no longer used by any agent (kept for future use)
    GEMINI_API_KEY: str = ""

    class Config:
        env_file = ".env"

settings = Settings()
