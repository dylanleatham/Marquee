"""fake-pn532 — a scripted PN532 reader for Stylus tests.

Returns a programmed sequence of tag reads ("tag / tag / gone / gone / tag(new UID)")
so the poll loop and state machine can be tested with no hardware and fake time.
"""
