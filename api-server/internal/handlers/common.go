package handlers

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func listOpts() metav1.ListOptions {
	return metav1.ListOptions{}
}

func getOpts() metav1.GetOptions {
	return metav1.GetOptions{}
}
