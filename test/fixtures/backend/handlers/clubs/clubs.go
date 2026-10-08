package clubs

import (
	"log"
	"net/http"

	"github.com/julienschmidt/httprouter"
)

func GetClubPaymentTypes(w http.ResponseWriter, req *http.Request, pm httprouter.Params) {
	w.WriteHeader(http.StatusUnauthorized)
}

func GetIsFederatedClub(w http.ResponseWriter, req *http.Request, pm httprouter.Params) {
	_, err := lookup()
	if err != nil {
		log.Printf("[GetIsFederatedClub] Failed to get federation info: %v\n", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}
}

func GetBookings(w http.ResponseWriter, req *http.Request, pm httprouter.Params) {}

func GetProfile(w http.ResponseWriter, req *http.Request, pm httprouter.Params) {}

func lookup() (bool, error) { return false, nil }
