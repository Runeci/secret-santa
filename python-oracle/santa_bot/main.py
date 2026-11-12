import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage

from .config import Config
from .db import Database
from .handlers import build_router
from .service import Service


def build_dispatcher(db: Database) -> Dispatcher:
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(build_router(Service(db)))
    return dp


async def run() -> None:
    logging.basicConfig(level=logging.INFO)
    cfg = Config.from_env()
    bot = Bot(cfg.token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = build_dispatcher(Database(cfg.db_path))
    await dp.start_polling(bot)


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
