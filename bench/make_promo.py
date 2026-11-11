#!/usr/bin/env python3
# CFDriver4MTO promo. usage: PROMO_ASSETS=dir python make_promo.py OUT.mp4 [scene,...]
import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from promo_run import main
main()
