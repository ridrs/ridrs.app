"""Entry point of the frozen sidecar: the same CLI as `python -m rsm.pipeline` (run, retime, _step, _memguard)."""
import multiprocessing
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()
    from rsm.pipeline.cli import main

    sys.exit(main())
