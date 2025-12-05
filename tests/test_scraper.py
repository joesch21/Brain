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


HTML_MULTI_AIRLINE = """
<table>
  <tr><th>Flight</th><th>Rego</th><th>Bay</th><th>Status</th><th>Destination</th><th>Scheduled</th></tr>
  <tr><td> QF742 </td><td>VH-QFA</td><td>T3</td><td>Boarding</td><td>PER</td><td>11:15</td></tr>
  <tr><td>VA855</td><td>VH-VOZ</td><td>T2</td><td>On Time</td><td>BNE</td><td>12:05</td></tr>
  <tr><td>ZL315</td><td>VH-ZLQ</td><td>Gate Closed</td><td>DBO</td><td>07:45</td></tr>
  <tr><td>JQ123</td><td>VH-JQX</td><td>T4</td><td>Delayed</td><td>OOL</td><td>15:30</td></tr>
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


@patch("scraper.requests.get")
def test_scraper_filters_multiple_airlines(mock_get):
    resp = Mock()
    resp.content = HTML_MULTI_AIRLINE.encode()
    resp.raise_for_status = Mock()
    mock_get.return_value = resp

    qf = get_flight_details("http://example.test", airline_prefixes=["QF"])
    va = get_flight_details("http://example.test", airline_prefixes=["va"])
    zl = get_flight_details("http://example.test", airline_prefixes=[" ZL "])
    jq = get_flight_details("http://example.test", airline_prefixes=["JQ", "QF"])

    assert [f["flight_number"].strip() for f in qf] == ["QF742"]
    assert [f["flight_number"].strip() for f in va] == ["VA855"]
    assert [f["flight_number"].strip() for f in zl] == ["ZL315"]
    assert sorted(f["flight_number"].strip() for f in jq) == ["JQ123", "QF742"]
