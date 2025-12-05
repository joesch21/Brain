import os
from unittest.mock import Mock, patch

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from scraper import get_flight_details  # noqa: E402


HTML_WITH_TIME = """
<table>
  <tr><th>Flight</th><th>Rego</th><th>Bay</th><th>Status</th><th>Destination</th><th>Scheduled</th></tr>
  <tr><td>JQ522</td><td>VH-ABC</td><td>T2</td><td>On Time</td><td>MEL</td><td>16:50</td></tr>
  <tr><td>JQ400</td><td>VH-DEF</td><td>T2</td><td>On Time</td><td>OOL</td><td>-</td></tr>
</table>
"""


@patch("scraper.requests.get")
def test_scraper_extracts_scheduled_time(mock_get):
    resp = Mock()
    resp.content = HTML_WITH_TIME.encode()
    resp.raise_for_status = Mock()
    mock_get.return_value = resp

    flights = get_flight_details("http://example.test", airline_prefixes=["JQ"])
    assert flights[0]["scheduled_time_str"] == "16:50"
    assert flights[1]["scheduled_time_str"] is None
